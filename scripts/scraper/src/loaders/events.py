from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

import psycopg

from ..parsers.event_details import BoutRow, EventDetails
from ..parsers.events import EventListItem
from ..utils.countries import map_country
from ..utils.logger import log
from ..utils.slugify import slug_with_id


@dataclass
class UpsertCounts:
    inserted: int = 0
    updated: int = 0
    skipped: int = 0


def _location_city(location: str | None) -> str | None:
    if not location:
        return None
    parts = [p.strip() for p in location.split(",") if p.strip()]
    return parts[0] if parts else None


def upsert_event_listing(
    conn: psycopg.Connection,
    items: Iterable[EventListItem],
    *,
    status: str,
    dry_run: bool = False,
) -> UpsertCounts:
    """Insert events from the completed/upcoming listing. Idempotent on ufc_stats_id."""
    counts = UpsertCounts()
    now = datetime.now(timezone.utc)

    with conn.cursor() as cur:
        for item in items:
            slug = slug_with_id(item.name, item.ufc_stats_id)
            city = _location_city(item.location)
            country = map_country(item.location)
            date_value = item.date or now

            if dry_run:
                log.info(
                    f"[DRY] event upsert ufc={item.ufc_stats_id} name={item.name!r} "
                    f"date={date_value.date().isoformat()} status={status}"
                )
                counts.inserted += 1
                continue

            cur.execute(
                """
                INSERT INTO event (
                    slug, name, short_name, promotion, date,
                    location_city, location_country, venue, status, ufc_stats_id
                )
                VALUES (%s, %s, %s, 'ufc', %s, %s, %s, NULL, %s::event_status, %s)
                ON CONFLICT (ufc_stats_id) DO UPDATE SET
                    name = EXCLUDED.name,
                    date = EXCLUDED.date,
                    location_city = COALESCE(EXCLUDED.location_city, event.location_city),
                    location_country = COALESCE(EXCLUDED.location_country, event.location_country),
                    status = EXCLUDED.status,
                    updated_at = now()
                RETURNING (xmax = 0) AS inserted
                """,
                (slug, item.name, item.name, date_value, city, country, status, item.ufc_stats_id),
            )
            row = cur.fetchone()
            if row and row[0]:
                counts.inserted += 1
            else:
                counts.updated += 1

    return counts


def upsert_event_details(
    conn: psycopg.Connection,
    *,
    ufc_stats_id: str,
    details: EventDetails,
    dry_run: bool = False,
) -> None:
    """Refresh an event row with the details page data (location, date).

    Bouts are written by `upsert_bouts`.
    """
    if dry_run:
        log.info(
            f"[DRY] event detail refresh ufc={ufc_stats_id} location={details.location!r}"
        )
        return

    city = _location_city(details.location)
    country = map_country(details.location)
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE event SET
                location_city = COALESCE(%s, location_city),
                location_country = COALESCE(%s, location_country),
                date = COALESCE(%s, date),
                updated_at = now()
            WHERE ufc_stats_id = %s
            """,
            (city, country, details.date, ufc_stats_id),
        )


def _resolve_fighter_ids(conn: psycopg.Connection, ufc_ids: list[str]) -> dict[str, str]:
    if not ufc_ids:
        return {}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT ufc_stats_id, id::text FROM fighter WHERE ufc_stats_id = ANY(%s)",
            (ufc_ids,),
        )
        return {ufc: fid for ufc, fid in cur.fetchall()}


def upsert_bouts(
    conn: psycopg.Connection,
    *,
    event_ufc_id: str,
    bouts: list[BoutRow],
    dry_run: bool = False,
) -> UpsertCounts:
    """Insert/update bout rows for a given event. Skips bouts whose fighters
    aren't in our `fighter` table yet (logged for manual review).
    """
    counts = UpsertCounts()
    if not bouts:
        return counts

    # Resolve event id and fighter ids in batch.
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM event WHERE ufc_stats_id = %s", (event_ufc_id,))
        row = cur.fetchone()
        if not row:
            log.warning(f"event {event_ufc_id} not in DB — cannot insert bouts")
            counts.skipped = len(bouts)
            return counts
        event_id = row[0]

    needed_fighter_ufc_ids = list({b.fighter_a_ufc_id for b in bouts} | {b.fighter_b_ufc_id for b in bouts})
    fighter_map = _resolve_fighter_ids(conn, needed_fighter_ufc_ids)

    bout_status_map = {"completed": "completed", "scheduled": "scheduled"}

    with conn.cursor() as cur:
        for b in bouts:
            f_a = fighter_map.get(b.fighter_a_ufc_id)
            f_b = fighter_map.get(b.fighter_b_ufc_id)
            if not f_a or not f_b:
                log.warning(
                    f"bout {b.ufc_stats_id}: fighter not in db "
                    f"(a={b.fighter_a_ufc_id}/{f_a is not None} "
                    f"b={b.fighter_b_ufc_id}/{f_b is not None}) — skip"
                )
                counts.skipped += 1
                continue

            if not b.weight_class:
                # Schema requires weight_class NOT NULL. Default to catchweight when unknown.
                weight_class = "catchweight"
            else:
                weight_class = b.weight_class

            winner_id = None
            if b.winner_side == "a":
                winner_id = f_a
            elif b.winner_side == "b":
                winner_id = f_b

            status = bout_status_map.get(b.status, "scheduled")

            if dry_run:
                log.info(
                    f"[DRY] bout {b.ufc_stats_id}: {b.fighter_a_name} vs {b.fighter_b_name} "
                    f"wc={weight_class} method={b.method} status={status}"
                )
                counts.inserted += 1
                continue

            cur.execute(
                """
                INSERT INTO bout (
                    event_id, fighter_a_id, fighter_b_id,
                    weight_class, is_title_fight, is_main_event, is_co_main_event,
                    scheduled_rounds, bout_order,
                    status, winner_id, method, method_detail, round_finished, time_finished_seconds,
                    ufc_stats_id
                ) VALUES (
                    %s, %s, %s,
                    %s::weight_class, %s, %s, %s,
                    %s, %s,
                    %s::bout_status, %s, %s::bout_method, %s, %s, %s,
                    %s
                )
                ON CONFLICT (ufc_stats_id) DO UPDATE SET
                    weight_class = EXCLUDED.weight_class,
                    is_title_fight = EXCLUDED.is_title_fight,
                    is_main_event = EXCLUDED.is_main_event,
                    is_co_main_event = EXCLUDED.is_co_main_event,
                    bout_order = EXCLUDED.bout_order,
                    status = EXCLUDED.status,
                    winner_id = COALESCE(EXCLUDED.winner_id, bout.winner_id),
                    method = COALESCE(EXCLUDED.method, bout.method),
                    -- Wave 16: always refresh method_detail from the
                    -- scrape so a future fix to map_method can iterate
                    -- from the raw text without needing a re-scrape.
                    method_detail = COALESCE(EXCLUDED.method_detail, bout.method_detail),
                    round_finished = COALESCE(EXCLUDED.round_finished, bout.round_finished),
                    time_finished_seconds = COALESCE(EXCLUDED.time_finished_seconds, bout.time_finished_seconds),
                    updated_at = now()
                RETURNING (xmax = 0) AS inserted
                """,
                (
                    event_id,
                    f_a,
                    f_b,
                    weight_class,
                    b.is_title_bout,
                    b.bout_order == 1,
                    b.bout_order == 2,
                    5 if b.bout_order == 1 else 3,
                    b.bout_order,
                    status,
                    winner_id,
                    b.method,
                    b.method_detail,
                    b.round_finished,
                    b.time_finished_seconds,
                    b.ufc_stats_id,
                ),
            )
            row = cur.fetchone()
            if row and row[0]:
                counts.inserted += 1
            else:
                counts.updated += 1

    return counts


@dataclass
class UntranslatedEvent:
    id: str
    name: str


def fetch_untranslated_events(
    conn: psycopg.Connection, limit: int | None = None
) -> list[UntranslatedEvent]:
    """Events still missing a Russian name, newest first."""
    sql = (
        "SELECT id::text, name FROM event "
        "WHERE name_ru IS NULL ORDER BY date DESC NULLS LAST"
    )
    params: tuple = ()
    if limit is not None:
        sql += " LIMIT %s"
        params = (limit,)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return [UntranslatedEvent(id=r[0], name=r[1]) for r in cur.fetchall()]


def save_event_name_ru(
    conn: psycopg.Connection, event_id: str, name_ru: str
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE event SET name_ru = %s WHERE id = %s::uuid",
            (name_ru, event_id),
        )

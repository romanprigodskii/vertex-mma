from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import psycopg

from ..parsers.fighter_details import FighterDetails
from ..parsers.fighters import FighterListItem
from ..utils.logger import log
from ..utils.slugify import slug_with_id


@dataclass
class UpsertCounts:
    inserted: int = 0
    updated: int = 0
    skipped: int = 0


@dataclass
class UntranslatedFighter:
    id: str
    name_en: str
    country_code: str | None


def fetch_untranslated_names(
    conn: psycopg.Connection, *, limit: int | None = None
) -> list[UntranslatedFighter]:
    """Fighters still missing a Russian name. Most-prominent first so a partial
    run covers the highest-traffic profiles."""
    sql = (
        "SELECT id::text, name_en, country_code FROM fighter "
        "WHERE name_ru IS NULL OR name_ru = '' "
        "ORDER BY vertex_score DESC NULLS LAST, name_en"
    )
    if limit is not None:
        sql += " LIMIT %s"
    with conn.cursor() as cur:
        cur.execute(sql, (limit,) if limit is not None else ())
        return [
            UntranslatedFighter(id=r[0], name_en=r[1], country_code=r[2])
            for r in cur.fetchall()
        ]


def save_fighter_name_ru(
    conn: psycopg.Connection, fighter_id: str, name_ru: str
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE fighter SET name_ru = %s, updated_at = now() "
            "WHERE id = %s::uuid",
            (name_ru, fighter_id),
        )


def upsert_fighter_listing(
    conn: psycopg.Connection,
    items: Iterable[FighterListItem],
    *,
    dry_run: bool = False,
) -> UpsertCounts:
    counts = UpsertCounts()

    with conn.cursor() as cur:
        for item in items:
            slug = slug_with_id(item.name_en, item.ufc_stats_id)
            # Mark single-fight or champion-belt-only entries as 'active'; we don't have enough
            # info from the listing alone to retire fighters. The enrich pass can refine.
            status = "active"

            if dry_run:
                log.info(
                    f"[DRY] fighter upsert ufc={item.ufc_stats_id} name={item.name_en!r} "
                    f"stance={item.stance} record={item.wins}-{item.losses}-{item.draws}"
                )
                counts.inserted += 1
                continue

            cur.execute(
                """
                INSERT INTO fighter (
                    slug, name_en, nickname, height_cm, reach_cm, stance, status, ufc_stats_id
                ) VALUES (
                    %s, %s, %s, %s, %s, %s::stance, %s::fighter_status, %s
                )
                ON CONFLICT (ufc_stats_id) DO UPDATE SET
                    name_en = EXCLUDED.name_en,
                    nickname = COALESCE(EXCLUDED.nickname, fighter.nickname),
                    height_cm = COALESCE(EXCLUDED.height_cm, fighter.height_cm),
                    reach_cm = COALESCE(EXCLUDED.reach_cm, fighter.reach_cm),
                    stance = EXCLUDED.stance,
                    updated_at = now()
                RETURNING (xmax = 0) AS inserted, id::text
                """,
                (
                    slug,
                    item.name_en,
                    item.nickname,
                    item.height_cm,
                    item.reach_cm,
                    item.stance,
                    status,
                    item.ufc_stats_id,
                ),
            )
            row = cur.fetchone()
            if row and row[0]:
                counts.inserted += 1
                fighter_id = row[1]
            else:
                counts.updated += 1
                fighter_id = row[1] if row else None

            # Seed fighter_stats_aggregate with the W/L/D from the listing.
            if fighter_id and any(v is not None for v in (item.wins, item.losses, item.draws)):
                cur.execute(
                    """
                    INSERT INTO fighter_stats_aggregate (
                        fighter_id, wins_total, losses_total, draws_total
                    ) VALUES (%s, %s, %s, %s)
                    ON CONFLICT (fighter_id) DO UPDATE SET
                        wins_total = COALESCE(EXCLUDED.wins_total, fighter_stats_aggregate.wins_total),
                        losses_total = COALESCE(EXCLUDED.losses_total, fighter_stats_aggregate.losses_total),
                        draws_total = COALESCE(EXCLUDED.draws_total, fighter_stats_aggregate.draws_total),
                        computed_at = now()
                    """,
                    (
                        fighter_id,
                        item.wins or 0,
                        item.losses or 0,
                        item.draws or 0,
                    ),
                )

    return counts


def update_fighter_from_details(
    conn: psycopg.Connection,
    *,
    ufc_stats_id: str,
    details: FighterDetails,
    dry_run: bool = False,
) -> None:
    if dry_run:
        log.info(
            f"[DRY] enrich fighter ufc={ufc_stats_id} dob={details.dob} "
            f"SLpM={details.stats.slpm}"
        )
        return

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE fighter SET
                dob = COALESCE(%s, dob),
                height_cm = COALESCE(%s, height_cm),
                reach_cm = COALESCE(%s, reach_cm),
                stance = COALESCE(%s::stance, stance),
                last_synced_at = now(),
                updated_at = now()
            WHERE ufc_stats_id = %s
            RETURNING id::text
            """,
            (
                details.dob,
                details.height_cm,
                details.reach_cm,
                details.stance if details.stance != "unknown" else None,
                ufc_stats_id,
            ),
        )
        row = cur.fetchone()
        if not row:
            return
        fighter_id = row[0]

        cur.execute(
            """
            INSERT INTO fighter_stats_aggregate (
                fighter_id,
                wins_total, losses_total, draws_total,
                slpm, str_acc, sapm, str_def, td_avg, td_acc, td_def, sub_avg
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (fighter_id) DO UPDATE SET
                wins_total = COALESCE(EXCLUDED.wins_total, fighter_stats_aggregate.wins_total),
                losses_total = COALESCE(EXCLUDED.losses_total, fighter_stats_aggregate.losses_total),
                draws_total = COALESCE(EXCLUDED.draws_total, fighter_stats_aggregate.draws_total),
                slpm = COALESCE(EXCLUDED.slpm, fighter_stats_aggregate.slpm),
                str_acc = COALESCE(EXCLUDED.str_acc, fighter_stats_aggregate.str_acc),
                sapm = COALESCE(EXCLUDED.sapm, fighter_stats_aggregate.sapm),
                str_def = COALESCE(EXCLUDED.str_def, fighter_stats_aggregate.str_def),
                td_avg = COALESCE(EXCLUDED.td_avg, fighter_stats_aggregate.td_avg),
                td_acc = COALESCE(EXCLUDED.td_acc, fighter_stats_aggregate.td_acc),
                td_def = COALESCE(EXCLUDED.td_def, fighter_stats_aggregate.td_def),
                sub_avg = COALESCE(EXCLUDED.sub_avg, fighter_stats_aggregate.sub_avg),
                computed_at = now()
            """,
            (
                fighter_id,
                details.wins or 0,
                details.losses or 0,
                details.draws or 0,
                details.stats.slpm,
                details.stats.str_acc,
                details.stats.sapm,
                details.stats.str_def,
                details.stats.td_avg,
                details.stats.td_acc,
                details.stats.td_def,
                details.stats.sub_avg,
            ),
        )

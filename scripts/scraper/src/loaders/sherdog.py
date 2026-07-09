"""DB writes for the Sherdog pre-UFC record pipeline.

fighter_sherdog_bout has no per-row natural key on Sherdog's side (no
stable fight ids), so a fighter's history sync is delete-and-reinsert
inside the caller's transaction — idempotent and self-healing when
Sherdog corrects a record. Match/sync bookkeeping lives on the fighter
row (sherdog_id, sherdog_match_status, sherdog_synced_at).

As everywhere else: loaders never commit — the step script owns the
transaction (autocommit=False).
"""

from __future__ import annotations

from typing import Iterable

import psycopg

from ..sherdog import SherdogFight
from ..utils.logger import log


def save_matched_history(
    conn: psycopg.Connection,
    *,
    fighter_id: str,
    sherdog_id: str,
    fights: Iterable[SherdogFight],
    dry_run: bool = False,
) -> int:
    """Set the match + replace the fighter's Sherdog history. Returns the
    number of fight rows written. Raises psycopg.errors.UniqueViolation if
    sherdog_id is already claimed by another fighter (mis-match signal —
    the caller rolls back and marks 'ambiguous')."""
    fights = list(fights)
    if dry_run:
        log.info(
            f"[DRY] fighter {fighter_id}: sherdog_id={sherdog_id}, "
            f"{len(fights)} history rows"
        )
        return len(fights)
    if not fights:
        # Never replace a real stored history with an empty parse — a
        # Sherdog layout change / interstitial page parses to zero fights
        # without raising, and an empty-but-matched fighter reads
        # downstream as a confident "zero pre-UFC fights" instead of
        # missing data. (A genuinely fight-less profile can only occur on
        # first sync, where there are no rows to protect.)
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM fighter_sherdog_bout WHERE fighter_id = %s::uuid",
                (fighter_id,),
            )
            existing = cur.fetchone()[0]
        if existing:
            raise ValueError(
                f"refusing to overwrite {existing} stored history rows "
                f"with an empty parse (fighter {fighter_id})"
            )
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE fighter
            SET sherdog_id = %s,
                sherdog_match_status = 'matched',
                sherdog_synced_at = now(),
                updated_at = now()
            WHERE id = %s::uuid
            """,
            (sherdog_id, fighter_id),
        )
        cur.execute(
            "DELETE FROM fighter_sherdog_bout WHERE fighter_id = %s::uuid",
            (fighter_id,),
        )
        cur.executemany(
            """
            INSERT INTO fighter_sherdog_bout
              (fighter_id, result, opponent_name, opponent_sherdog_id,
               event_name, event_date, method, method_class, round,
               time_seconds, is_ufc)
            VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                (
                    fighter_id,
                    f.result,
                    f.opponent_name,
                    f.opponent_sherdog_id,
                    f.event_name,
                    f.event_date,
                    f.method,
                    f.method_class,
                    f.round,
                    f.time_seconds,
                    f.is_ufc,
                )
                for f in fights
            ],
        )
    return len(fights)


def mark_match_status(
    conn: psycopg.Connection,
    *,
    fighter_id: str,
    status: str,  # 'unmatched' | 'ambiguous'
    dry_run: bool = False,
) -> None:
    """Record a failed match attempt. sherdog_synced_at stays NULL (it
    means "history synced"); sherdog_id stays NULL so upcoming-bout
    fighters get retried by the incremental target query."""
    if dry_run:
        log.info(f"[DRY] fighter {fighter_id}: match_status={status}")
        return
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE fighter
            SET sherdog_match_status = %s, updated_at = now()
            WHERE id = %s::uuid
            """,
            (status, fighter_id),
        )

from __future__ import annotations

import psycopg

from ..parsers.bout_stats import FighterRoundStats
from ..utils.logger import log


def insert_round_stats(
    conn: psycopg.Connection,
    *,
    bout_ufc_id: str,
    rounds: list[FighterRoundStats],
    dry_run: bool = False,
) -> int:
    """Insert per-(round, fighter) stats. Idempotent on the (bout, fighter, round) unique key."""
    if not rounds:
        return 0

    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM bout WHERE ufc_stats_id = %s", (bout_ufc_id,))
        bout_row = cur.fetchone()
        if not bout_row:
            log.warning(f"bout {bout_ufc_id} not in db — cannot insert round stats")
            return 0
        bout_id = bout_row[0]

        # Map fighter ufc ids → uuids.
        fids = list({r.fighter_ufc_id for r in rounds})
        cur.execute(
            "SELECT ufc_stats_id, id::text FROM fighter WHERE ufc_stats_id = ANY(%s)",
            (fids,),
        )
        fighter_map = {ufc: fid for ufc, fid in cur.fetchall()}

        inserted = 0
        for r in rounds:
            f_uuid = fighter_map.get(r.fighter_ufc_id)
            if not f_uuid:
                log.warning(
                    f"bout {bout_ufc_id} round {r.round}: fighter {r.fighter_ufc_id} missing — skip"
                )
                continue

            if dry_run:
                log.info(
                    f"[DRY] bout_round_stats bout={bout_ufc_id} round={r.round} "
                    f"fighter={r.fighter_ufc_id} sig={r.sig_str_landed}/{r.sig_str_attempted}"
                )
                inserted += 1
                continue

            cur.execute(
                """
                INSERT INTO bout_round_stats (
                    bout_id, fighter_id, round,
                    sig_str_landed, sig_str_attempted,
                    sig_str_head_landed, sig_str_head_attempted,
                    sig_str_body_landed, sig_str_body_attempted,
                    sig_str_legs_landed, sig_str_legs_attempted,
                    sig_str_distance_landed, sig_str_clinch_landed, sig_str_ground_landed,
                    total_str_landed, total_str_attempted,
                    takedowns_landed, takedowns_attempted,
                    sub_attempts, reversals, control_time_seconds,
                    knockdowns
                ) VALUES (
                    %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s, %s,
                    %s
                )
                ON CONFLICT (bout_id, fighter_id, round) DO UPDATE SET
                    sig_str_landed = EXCLUDED.sig_str_landed,
                    sig_str_attempted = EXCLUDED.sig_str_attempted,
                    sig_str_head_landed = EXCLUDED.sig_str_head_landed,
                    sig_str_head_attempted = EXCLUDED.sig_str_head_attempted,
                    sig_str_body_landed = EXCLUDED.sig_str_body_landed,
                    sig_str_body_attempted = EXCLUDED.sig_str_body_attempted,
                    sig_str_legs_landed = EXCLUDED.sig_str_legs_landed,
                    sig_str_legs_attempted = EXCLUDED.sig_str_legs_attempted,
                    sig_str_distance_landed = EXCLUDED.sig_str_distance_landed,
                    sig_str_clinch_landed = EXCLUDED.sig_str_clinch_landed,
                    sig_str_ground_landed = EXCLUDED.sig_str_ground_landed,
                    total_str_landed = EXCLUDED.total_str_landed,
                    total_str_attempted = EXCLUDED.total_str_attempted,
                    takedowns_landed = EXCLUDED.takedowns_landed,
                    takedowns_attempted = EXCLUDED.takedowns_attempted,
                    sub_attempts = EXCLUDED.sub_attempts,
                    reversals = EXCLUDED.reversals,
                    control_time_seconds = EXCLUDED.control_time_seconds,
                    knockdowns = EXCLUDED.knockdowns
                """,
                (
                    bout_id, f_uuid, r.round,
                    r.sig_str_landed, r.sig_str_attempted,
                    r.sig_str_head_landed, r.sig_str_head_attempted,
                    r.sig_str_body_landed, r.sig_str_body_attempted,
                    r.sig_str_legs_landed, r.sig_str_legs_attempted,
                    r.sig_str_distance_landed, r.sig_str_clinch_landed, r.sig_str_ground_landed,
                    r.total_str_landed, r.total_str_attempted,
                    r.takedowns_landed, r.takedowns_attempted,
                    r.sub_attempts, r.reversals, r.control_time_seconds,
                    r.knockdowns,
                ),
            )
            inserted += 1
        return inserted

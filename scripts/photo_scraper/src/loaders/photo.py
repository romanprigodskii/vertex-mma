from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import psycopg

from ..utils.logger import log


@dataclass
class PhotoRow:
    fighter_id: str
    photo_url: str | None
    photo_thumbnail_url: str | None
    photo_license: str | None
    photo_source_url: str | None
    photo_attribution: str | None
    wikipedia_url: str | None
    status: str  # 'success' | 'no_match' | 'license_blocked' | 'fetch_error'


def update_fighter_photo(conn: psycopg.Connection, *, row: PhotoRow, dry_run: bool = False) -> None:
    if dry_run:
        log.info(
            f"[DRY] fighter {row.fighter_id}: status={row.status} "
            f"photo_url={row.photo_url} license={row.photo_license}"
        )
        return

    now = datetime.now(timezone.utc)
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE fighter SET
                photo_url = %s,
                photo_thumbnail_url = %s,
                photo_license = %s,
                photo_source_url = %s,
                photo_attribution = %s,
                wikipedia_url = COALESCE(%s, wikipedia_url),
                photo_fetched_at = %s,
                photo_fetch_status = %s,
                updated_at = now()
            WHERE id = %s::uuid
            """,
            (
                row.photo_url,
                row.photo_thumbnail_url,
                row.photo_license,
                row.photo_source_url,
                row.photo_attribution,
                row.wikipedia_url,
                now,
                row.status,
                row.fighter_id,
            ),
        )

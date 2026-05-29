"""Fetch official UFC athlete photos for fighters that still have no photo and
store them as transparent cutouts (no background) — a full-res image plus a
head+shoulders avatar.

Targets fighters whose photo_url is NULL (these already failed the free-license
Wikipedia pass), most-ranked first. Source is UFC's `athlete_bio_full_body`
transparent PNG (~460x700, the largest public variant). UFC images are
promotional / copyrighted — used here as an editorial fan-site decision;
attribution is stored and status is set to 'success' so the app shows them.

Usage:
  ./venv/bin/python scripts/fetch_photos_ufc.py --dry-run --limit 5   # saves samples to ~/Downloads/ufc_photo_samples
  ./venv/bin/python scripts/fetch_photos_ufc.py --top 100
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import psycopg

import _path  # noqa: F401

from src.db import get_connection
from src.dns_override import install as install_dns_override
from src.loaders.photo import PhotoRow, update_fighter_photo
from src.storage import public_url, upload
from src.ufc_photos import process_cutout, fetch_ufc_image
from src.utils.logger import log

install_dns_override()

SAMPLE_DIR = Path.home() / "Downloads" / "ufc_photo_samples"
DELAY_SECONDS = 0.4  # be polite to ufc.com
NO_PHOTO_STATUS = "ufc_no_photo"  # marks a UFC miss so reruns skip it


def _targets(conn, top: int, limit: int | None, all_missing: bool) -> list[dict]:
    with conn.cursor() as cur:
        if all_missing:
            # Every fighter not yet sourced from UFC, most-ranked first. Includes
            # those with an existing (e.g. Wikipedia) photo so they get the
            # uniform transparent UFC cutout — skipping ones already UFC-sourced
            # or that a previous UFC run already failed on.
            cur.execute(
                """
                SELECT id::text, slug, name_en
                FROM fighter
                WHERE photo_fetch_status IS DISTINCT FROM %s
                  AND photo_license IS DISTINCT FROM 'ufc_editorial'
                ORDER BY vertex_score DESC NULLS LAST, name_en
                """,
                (NO_PHOTO_STATUS,),
            )
        else:
            cur.execute(
                """
                WITH ranked AS (
                    SELECT id, slug, name_en, vertex_score,
                           row_number() OVER (ORDER BY vertex_score DESC NULLS LAST) AS rn
                    FROM fighter
                    WHERE vertex_score IS NOT NULL
                )
                SELECT id::text, slug, name_en
                FROM ranked
                WHERE rn <= %s
                  AND id IN (SELECT id FROM fighter WHERE photo_url IS NULL)
                ORDER BY rn
                """,
                (top,),
            )
        cols = [d.name for d in cur.description]
        rows = [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]
    return rows[:limit] if limit is not None else rows


def run(
    *,
    top: int = 100,
    limit: int | None = None,
    dry_run: bool = False,
    all_missing: bool = False,
) -> dict:
    totals = {"fetched": 0, "no_photo": 0, "error": 0}
    if dry_run:
        SAMPLE_DIR.mkdir(parents=True, exist_ok=True)

    conn = get_connection()
    try:
        targets = _targets(conn, top, limit, all_missing)
        scope = "all missing" if all_missing else f"top-{top}"
        log.info(
            f"UFC photos: {len(targets)} {scope} fighter(s) without a photo "
            f"(dry_run={dry_run})"
        )
        for f in targets:
            fid, slug, name = f["id"], f["slug"], f["name_en"]
            img, reason = fetch_ufc_image(name)
            try:
                if img is None:
                    totals["no_photo"] += 1
                    log.warning(f"  {name}: no UFC photo ({reason})")
                    # A network blip isn't a real miss — leave it unmarked so a
                    # rerun retries. A genuine miss (404 / no image) gets marked
                    # so reruns skip it; status-only update PRESERVES any
                    # existing photo.
                    if not dry_run and not reason.startswith("network_error"):
                        with conn.cursor() as cur:
                            cur.execute(
                                "UPDATE fighter SET photo_fetch_status = %s WHERE id = %s::uuid",
                                (NO_PHOTO_STATUS, fid),
                            )
                        conn.commit()
                    time.sleep(DELAY_SECONDS)
                    continue

                try:
                    processed = process_cutout(img.raw)
                except Exception as exc:
                    totals["error"] += 1
                    log.error(f"  {name}: processing failed — {exc!r}")
                    continue

                if dry_run:
                    out = SAMPLE_DIR / f"{slug}.webp"
                    out.write_bytes(processed.full_webp)
                    (SAMPLE_DIR / f"{slug}_thumb.webp").write_bytes(
                        processed.thumbnail_webp
                    )
                    totals["fetched"] += 1
                    log.info(f"  {name}: sample → {out}")
                    continue

                try:
                    full_url = upload(f"{slug}/full.webp", content=processed.full_webp)
                    upload(f"{slug}/thumbnail.webp", content=processed.thumbnail_webp)
                except Exception as exc:
                    totals["error"] += 1
                    log.error(f"  {name}: upload failed — {exc!r}")
                    continue

                update_fighter_photo(
                    conn,
                    row=PhotoRow(
                        fighter_id=fid,
                        photo_url=full_url,
                        photo_thumbnail_url=public_url(f"{slug}/thumbnail.webp"),
                        photo_license="ufc_editorial",
                        photo_source_url=img.page_url,
                        photo_attribution="© UFC",
                        wikipedia_url=None,
                        status="success",
                    ),
                )
                conn.commit()
                totals["fetched"] += 1
                log.info(f"  {name}: uploaded {full_url}")
                time.sleep(DELAY_SECONDS)
            except psycopg.OperationalError as exc:
                # Pooler dropped the connection (idle during a slow fetch, or a
                # network blip). Reconnect and move on — this fighter is left
                # uncommitted and a rerun will pick it up.
                totals["error"] += 1
                log.warning(f"  {name}: DB connection lost ({exc!r}) — reconnecting")
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass
                conn = get_connection()
                time.sleep(DELAY_SECONDS)
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass

    log.info(
        f"UFC photos done: fetched={totals['fetched']} "
        f"no_photo={totals['no_photo']} error={totals['error']}"
    )
    return totals


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=100)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--all", action="store_true", help="every fighter without a photo")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    run(top=args.top, limit=args.limit, dry_run=args.dry_run, all_missing=args.all)

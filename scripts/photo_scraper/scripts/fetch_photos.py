from __future__ import annotations

import argparse
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import _path  # noqa: F401

from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn

from src.db import get_connection
from src.http import Client
from src.image_processor import process as process_image
from src.loaders.photo import PhotoRow, update_fighter_photo
from src.storage import StorageError, public_url, upload
from src.utils.logger import log, record_error
from src.wikipedia import fetch_image_license, find_candidate


def _select_targets(conn, limit: int | None) -> list[dict]:
    """Pick fighters that don't have a photo yet, ordered by bout count desc (popular first)."""
    with conn.cursor() as cur:
        sql = """
            SELECT
                f.id::text AS id,
                f.slug,
                f.name_en,
                f.nickname,
                f.dob,
                f.country_code,
                (
                    SELECT COUNT(*) FROM bout b
                    WHERE b.fighter_a_id = f.id OR b.fighter_b_id = f.id
                ) AS bout_count
            FROM fighter f
            WHERE f.ufc_stats_id IS NOT NULL
              AND (f.photo_fetch_status IS NULL OR f.photo_fetch_status = 'fetch_error')
            ORDER BY bout_count DESC, f.name_en ASC
        """
        if limit is not None:
            sql += " LIMIT %s"
            cur.execute(sql, (limit,))
        else:
            cur.execute(sql)
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]


def _process_one(http: Client, fighter: dict, *, dry_run: bool) -> PhotoRow:
    """Run search → license check → download → process → upload → DB update for one fighter."""
    fighter_id = fighter["id"]
    slug = fighter["slug"]
    name = fighter["name_en"]

    candidate, reason = find_candidate(
        http,
        name_en=name,
        nickname=fighter.get("nickname"),
        dob=fighter.get("dob"),
        country_code=fighter.get("country_code"),
    )
    if candidate is None:
        log.info(f"{name}: no match ({reason})")
        return PhotoRow(
            fighter_id=fighter_id,
            photo_url=None,
            photo_thumbnail_url=None,
            photo_license=None,
            photo_source_url=None,
            photo_attribution=None,
            wikipedia_url=None,
            status="no_match",
        )

    license_info = None
    if candidate.image_title:
        license_info = fetch_image_license(http, candidate.image_title)

    if license_info is None or not license_info.allowed:
        license_str = license_info.license_short if license_info else "unknown"
        log.info(
            f"{name}: license blocked or missing ({license_str!r}) "
            f"wiki={candidate.url}"
        )
        return PhotoRow(
            fighter_id=fighter_id,
            photo_url=None,
            photo_thumbnail_url=None,
            photo_license=license_str,
            photo_source_url=candidate.url,
            photo_attribution=license_info.attribution if license_info else None,
            wikipedia_url=candidate.url,
            status="license_blocked",
        )

    image_url = candidate.original_image_url or candidate.thumbnail_url
    if not image_url:
        return PhotoRow(
            fighter_id=fighter_id,
            photo_url=None,
            photo_thumbnail_url=None,
            photo_license=license_info.license_short,
            photo_source_url=candidate.url,
            photo_attribution=license_info.attribution,
            wikipedia_url=candidate.url,
            status="fetch_error",
        )

    if dry_run:
        log.info(
            f"[DRY] {name}: would download {image_url} "
            f"license={license_info.license_short!r} attribution={license_info.attribution!r}"
        )
        return PhotoRow(
            fighter_id=fighter_id,
            photo_url=public_url(f"{slug}/full.webp"),
            photo_thumbnail_url=public_url(f"{slug}/thumbnail.webp"),
            photo_license=license_info.license_short,
            photo_source_url=candidate.url,
            photo_attribution=license_info.attribution,
            wikipedia_url=candidate.url,
            status="success",
        )

    try:
        raw = http.get_bytes(image_url)
        processed = process_image(raw)
        full_url = upload(f"{slug}/full.webp", content=processed.full_webp)
        thumb_url = upload(f"{slug}/thumbnail.webp", content=processed.thumbnail_webp)
    except StorageError as exc:
        record_error(fighter_slug=slug, kind="storage_upload", message=repr(exc))
        return PhotoRow(
            fighter_id=fighter_id,
            photo_url=None,
            photo_thumbnail_url=None,
            photo_license=license_info.license_short,
            photo_source_url=candidate.url,
            photo_attribution=license_info.attribution,
            wikipedia_url=candidate.url,
            status="fetch_error",
        )
    except Exception as exc:  # noqa: BLE001 — capture parse/decode failures
        record_error(fighter_slug=slug, kind="download_or_process", message=repr(exc))
        return PhotoRow(
            fighter_id=fighter_id,
            photo_url=None,
            photo_thumbnail_url=None,
            photo_license=license_info.license_short,
            photo_source_url=candidate.url,
            photo_attribution=license_info.attribution,
            wikipedia_url=candidate.url,
            status="fetch_error",
        )

    log.info(
        f"{name}: uploaded full={full_url} attribution={license_info.attribution!r}"
    )
    return PhotoRow(
        fighter_id=fighter_id,
        photo_url=full_url,
        photo_thumbnail_url=thumb_url,
        photo_license=license_info.license_short,
        photo_source_url=candidate.url,
        photo_attribution=license_info.attribution,
        wikipedia_url=candidate.url,
        status="success",
    )


_thread_local = threading.local()


def _thread_client() -> Client:
    """Per-thread httpx Client so each worker has its own throttle clock."""
    client = getattr(_thread_local, "client", None)
    if client is None:
        client = Client()
        _thread_local.client = client
    return client


def _thread_conn():
    """Per-thread psycopg Connection — psycopg connections are not safe for concurrent use."""
    conn = getattr(_thread_local, "conn", None)
    if conn is None:
        conn = get_connection()
        _thread_local.conn = conn
    return conn


def _process_and_write(fighter: dict, *, dry_run: bool) -> PhotoRow:
    http = _thread_client()
    conn = _thread_conn()
    row = _process_one(http, fighter, dry_run=dry_run)
    update_fighter_photo(conn, row=row, dry_run=dry_run)
    if not dry_run:
        conn.commit()
    return row


def _run_sequential(targets: list[dict], *, dry_run: bool, progress, task) -> dict[str, int]:
    totals: dict[str, int] = {"success": 0, "no_match": 0, "license_blocked": 0, "fetch_error": 0}
    with Client() as http, get_connection() as conn:
        for fighter in targets:
            row = _process_one(http, fighter, dry_run=dry_run)
            totals[row.status] = totals.get(row.status, 0) + 1
            update_fighter_photo(conn, row=row, dry_run=dry_run)
            if not dry_run:
                conn.commit()
            progress.advance(task)
    return totals


def _run_parallel(targets: list[dict], *, dry_run: bool, workers: int, progress, task) -> dict[str, int]:
    """Each worker thread owns its own Client + Connection. The Wikipedia/Commons rate limit is
    enforced *per* Client, so ~`workers` requests/sec is the aggregate ceiling — well inside
    Wikimedia's published rate guidance for identified user-agents.
    """
    totals: dict[str, int] = {"success": 0, "no_match": 0, "license_blocked": 0, "fetch_error": 0}
    totals_lock = threading.Lock()

    with ThreadPoolExecutor(max_workers=workers) as exe:
        futures = [exe.submit(_process_and_write, f, dry_run=dry_run) for f in targets]
        for fut in as_completed(futures):
            try:
                row = fut.result()
            except Exception as exc:  # noqa: BLE001 — keep the pool alive on a single fighter blowing up
                log.error(f"worker error: {exc!r}")
                with totals_lock:
                    totals["fetch_error"] += 1
                    progress.advance(task)
                continue
            with totals_lock:
                totals[row.status] = totals.get(row.status, 0) + 1
                progress.advance(task)

    return totals


def run(*, limit: int | None = None, dry_run: bool = False, workers: int = 1) -> dict[str, int]:
    with get_connection() as conn:
        targets = _select_targets(conn, limit=limit)
    log.info(
        f"photo scraper: {len(targets)} fighter targets "
        f"(dry_run={dry_run}, workers={workers})"
    )

    with Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("[cyan]{task.completed}/{task.total}[/]"),
        TimeElapsedColumn(),
    ) as progress:
        task = progress.add_task("Fighters", total=len(targets))

        if workers <= 1:
            totals = _run_sequential(targets, dry_run=dry_run, progress=progress, task=task)
        else:
            totals = _run_parallel(
                targets, dry_run=dry_run, workers=workers, progress=progress, task=task
            )

    log.info(f"photo scraper done: {totals}")
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description="Wikipedia photo enrichment.")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Parallel worker threads (default 1, recommended 4 for full runs).",
    )
    args = parser.parse_args()
    run(limit=args.limit, dry_run=args.dry_run, workers=args.workers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

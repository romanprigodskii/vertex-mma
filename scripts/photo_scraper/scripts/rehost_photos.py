"""Re-fetch every fighter photo the deleted Supabase bucket was holding and
rewrite the rows to point at our own origin.

The bucket (and the project around it) is gone — `ctixvxfmgrthnspfofsc.supabase.co`
does not even resolve — so 2,400 `fighter.photo_url` values point at nothing.
There is no copy of the bytes to restore, but every row kept the page it came
from in `photo_source_url`, so the photos can simply be fetched again:

  * `ufc_editorial` rows  → the UFC athlete page, re-cut the same way.
  * CC-licensed rows      → the Wikipedia article's original image.

Photos land in the local store (see src/storage.py) as <slug>/full.webp and
<slug>/thumbnail.webp — the same relative paths the bucket used, so the DB
update is a base-URL swap and nothing downstream has to learn a new shape.
`--publish` rsyncs the tree to the origin afterwards.

Fetching has to run from a residential connection: ufc.com answers the VPS with
a 403.

Usage:
  ./venv/bin/python scripts/rehost_photos.py --limit 5 --dry-run
  ./venv/bin/python scripts/rehost_photos.py           # everything still broken
  ./venv/bin/python scripts/rehost_photos.py --publish # ...then push it up
"""
from __future__ import annotations

import argparse
import logging
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import psycopg

import _path  # noqa: F401

from src.config import PHOTO_PUBLIC_BASE
from src.db import get_connection
from src.dns_override import install as install_dns_override
from src.http import Client
from src.image_processor import process as process_plain
from src.storage import local_path, publish, public_url, upload
from src.ufc_photos import fetch_ufc_image_at, process_cutout
from src.utils.logger import log
from src.wikipedia import fetch_summary

install_dns_override()

# One INFO line per request times 2,400 fighters buries the run's own output.
logging.getLogger("httpx").setLevel(logging.WARNING)

# The host that vanished. Rows still pointing at it are the ones to repair.
DEAD_HOST = "ctixvxfmgrthnspfofsc.supabase.co"

# Refetching 2,400 athlete pages one at a time is a four-hour job — each page is
# ~130 KB before the image even starts. Workers overlap that waiting; the gate
# below keeps the *combined* request rate polite regardless of how many there
# are, which a per-worker sleep would not.
DEFAULT_JOBS = 6
MIN_REQUEST_GAP = 0.25  # seconds between outbound fetches, across all workers


class _Gate:
    """Global rate limit: no two fetches start closer together than the gap."""

    def __init__(self, gap: float) -> None:
        self._gap = gap
        self._lock = threading.Lock()
        self._last = 0.0

    def wait(self) -> None:
        with self._lock:
            delta = time.monotonic() - self._last
            if delta < self._gap:
                time.sleep(self._gap - delta)
            self._last = time.monotonic()


_gate = _Gate(MIN_REQUEST_GAP)


@dataclass
class Target:
    fighter_id: str
    slug: str
    name_en: str
    license: str | None
    source_url: str | None


def _targets(conn, *, limit: int | None, all_photos: bool) -> list[Target]:
    where = (
        "photo_url IS NOT NULL"
        if all_photos
        else "photo_url LIKE %(dead)s"
    )
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT id::text, slug, name_en, photo_license, photo_source_url
            FROM fighter
            WHERE {where}
            ORDER BY vertex_score DESC NULLS LAST, name_en
            """,
            {"dead": f"%{DEAD_HOST}%"},
        )
        rows = cur.fetchall()
    targets = [Target(*r) for r in rows]
    return targets[:limit] if limit is not None else targets


def _wikipedia_title(source_url: str) -> str | None:
    """https://en.wikipedia.org/wiki/Bas_Rutten → Bas Rutten."""
    path = urllib.parse.urlparse(source_url).path
    if not path.startswith("/wiki/"):
        return None
    return urllib.parse.unquote(path[len("/wiki/") :]).replace("_", " ")


def _fetch_wikipedia(client: Client, source_url: str) -> tuple[bytes | None, str]:
    title = _wikipedia_title(source_url)
    if not title:
        return None, "not_a_wiki_url"
    summary = fetch_summary(client, title)
    if not summary:
        return None, "summary_404"
    src = (summary.get("originalimage") or {}).get("source") or (
        summary.get("thumbnail") or {}
    ).get("source")
    if not src:
        return None, "no_image_on_article"
    try:
        return client.get_bytes(src), "ok"
    except Exception as exc:  # noqa: BLE001 — a flaky fetch is one miss, not a crash
        return None, f"image_error:{type(exc).__name__}"


def _already_stored(slug: str) -> bool:
    return local_path(f"{slug}/full.webp").exists() and local_path(
        f"{slug}/thumbnail.webp"
    ).exists()


def _repoint(conn, *, fighter_id: str, slug: str) -> None:
    """Point the row at the new origin. Only photo_* URLs move — license,
    attribution and source stay exactly as they were, because the photo is the
    same photo from the same place."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE fighter
            SET photo_url = %s,
                photo_thumbnail_url = %s,
                photo_fetched_at = now(),
                photo_fetch_status = 'success',
                updated_at = now()
            WHERE id = %s::uuid
            """,
            (
                public_url(f"{slug}/full.webp"),
                public_url(f"{slug}/thumbnail.webp"),
                fighter_id,
            ),
        )


def _fetch_one(t: Target, *, client: Client, dry_run: bool) -> tuple[Target, str]:
    """Fetch, process and write one fighter's photos. Returns (target, outcome)
    where outcome is 'ok', 'reused', or a reason it could not be recovered.
    Runs on a worker thread: it touches the network and the filesystem, never
    the database."""
    if not t.source_url:
        return t, "no_source_url"

    _gate.wait()
    if t.license == "ufc_editorial":
        img, reason = fetch_ufc_image_at(t.source_url)
        raw = img.raw if img else None
        processor = process_cutout
    else:
        raw, reason = _fetch_wikipedia(client, t.source_url)
        processor = process_plain

    if raw is None:
        return t, reason
    try:
        processed = processor(raw)
    except Exception as exc:  # noqa: BLE001
        return t, f"processing_failed:{type(exc).__name__}"
    if dry_run:
        return t, "ok"

    upload(f"{t.slug}/full.webp", content=processed.full_webp)
    upload(f"{t.slug}/thumbnail.webp", content=processed.thumbnail_webp)
    return t, "ok"


def run(
    *,
    limit: int | None = None,
    dry_run: bool = False,
    force: bool = False,
    all_photos: bool = False,
    do_publish: bool = False,
    jobs: int = DEFAULT_JOBS,
) -> dict:
    totals = {"rehosted": 0, "reused": 0, "lost": 0, "error": 0}
    losses: list[tuple[str, str]] = []
    conn = get_connection()
    client = Client(rate_limit_seconds=0.0)  # the shared gate does the throttling
    try:
        targets = _targets(conn, limit=limit, all_photos=all_photos)

        # Anything already in the store just needs its row repointed — no
        # network at all, so settle those first and keep the pool for the rest.
        pending: list[Target] = []
        for t in targets:
            if not force and _already_stored(t.slug):
                if not dry_run:
                    _repoint(conn, fighter_id=t.fighter_id, slug=t.slug)
                totals["reused"] += 1
            else:
                pending.append(t)
        if not dry_run:
            conn.commit()

        log.info(
            f"rehost: {len(pending)} to fetch, {totals['reused']} already stored "
            f"→ {PHOTO_PUBLIC_BASE} (jobs={jobs}, dry_run={dry_run})"
        )

        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            futures = [
                pool.submit(_fetch_one, t, client=client, dry_run=dry_run)
                for t in pending
            ]
            for i, future in enumerate(futures, start=1):
                # Tick at the top: a fighter whose photo could not be recovered
                # takes a `continue` below, and progress that only prints on the
                # happy path reads as a stall.
                if i % 100 == 0:
                    rate = i / max(time.monotonic() - started, 1e-6)
                    left = (len(futures) - i) / max(rate, 1e-6)
                    log.info(
                        f"  … {i}/{len(futures)} at {rate:.1f}/s, ~{left / 60:.0f} min left"
                    )
                try:
                    t, outcome = future.result()
                except Exception as exc:  # noqa: BLE001 — one bad fighter, not a dead run
                    totals["error"] += 1
                    log.error(f"  worker failed: {exc!r}")
                    continue

                if outcome != "ok":
                    totals["lost"] += 1
                    losses.append((t.name_en, outcome))
                    continue

                totals["rehosted"] += 1
                if dry_run:
                    continue
                try:
                    _repoint(conn, fighter_id=t.fighter_id, slug=t.slug)
                    if totals["rehosted"] % 25 == 0:
                        conn.commit()
                except psycopg.OperationalError as exc:
                    # Connection dropped while it idled between writes. The
                    # bytes are on disk, so a rerun repoints this row for free.
                    totals["error"] += 1
                    log.warning(f"  {t.name_en}: DB connection lost ({exc!r}) — reconnecting")
                    conn = get_connection()
        if not dry_run:
            conn.commit()
    finally:
        client.close()
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass

    log.info(
        f"rehost done: rehosted={totals['rehosted']} reused={totals['reused']} "
        f"lost={totals['lost']} error={totals['error']}"
    )
    for name, reason in losses[:40]:
        log.warning(f"  lost: {name} ({reason})")
    if len(losses) > 40:
        log.warning(f"  … and {len(losses) - 40} more")
    if do_publish and not dry_run:
        publish()
    return totals


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--force", action="store_true", help="refetch even if the store already has it"
    )
    ap.add_argument(
        "--all",
        action="store_true",
        help="every fighter with a photo, not just the broken ones",
    )
    ap.add_argument("--publish", action="store_true", help="rsync the store afterwards")
    ap.add_argument("--jobs", type=int, default=DEFAULT_JOBS)
    args = ap.parse_args()
    run(
        limit=args.limit,
        dry_run=args.dry_run,
        force=args.force,
        all_photos=args.all,
        do_publish=args.publish,
        jobs=args.jobs,
    )

#!/usr/bin/env python3
"""Wayback-Machine scraper for ufc.com/rankings — Wave 6C.1 task 2.

Two phases:
  1. Query the CDX API for every ufc.com/rankings snapshot returning HTTP
     200 between 2017-01-01 and today, collapsed by digest so we don't
     download identical pages twice.
  2. Bucket the results into 14-day windows. For each window, pick the
     snapshot closest to its midpoint, then GET it and write to
     imports/ufc_rankings_raw/{YYYYMMDD}.html.

Idempotent: if the output file already exists and is non-empty, skip the
download. Polite: sleep 1s between requests, exponential backoff on
429/503, give up on a single snapshot after 3 failures and continue.

Manifest at imports/ufc_rankings_raw/_manifest.json maps date → {url,
status, bytes}; rewritten on every full run, updated incrementally as
downloads succeed so a Ctrl-C resume is possible.

Usage:
    python3 scripts/scrape_ufc_rankings.py
"""
from __future__ import annotations

import json
import logging
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "imports" / "ufc_rankings_raw"
MANIFEST_PATH = RAW_DIR / "_manifest.json"
LOG_PATH = ROOT / "scripts" / "scrape_ufc_rankings.log"

CDX_URL = (
    "https://web.archive.org/cdx/search/cdx"
    "?url=ufc.com/rankings"
    "&from={start}&to={end}"
    "&output=json"
    "&filter=statuscode:200"
    "&collapse=digest"
)
WAYBACK_TEMPLATE = "https://web.archive.org/web/{ts}/{url}"
USER_AGENT = "Mozilla/5.0 vertex-mma-research (rankings infrastructure)"

START_DATE = date(2017, 1, 1)
WINDOW_DAYS = 14
REQUEST_DELAY = 1.0
MAX_ATTEMPTS = 3

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, mode="a"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)


def fetch(url: str, *, timeout: int = 60) -> bytes:
    """HTTP GET with our UA. Raises URLError/HTTPError to caller."""
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_with_retry(url: str, label: str) -> bytes | None:
    """GET with exponential backoff on 429/503 + transient socket errors.
    None means give up after MAX_ATTEMPTS."""
    delay = 2.0
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return fetch(url)
        except HTTPError as e:
            if e.code in (429, 503):
                log.warning(
                    "%s: HTTP %s on attempt %d/%d, sleeping %.1fs",
                    label, e.code, attempt, MAX_ATTEMPTS, delay,
                )
                time.sleep(delay)
                delay *= 2
                continue
            log.error("%s: HTTP %s (giving up)", label, e.code)
            return None
        except (URLError, TimeoutError, ConnectionError, OSError) as e:
            # TimeoutError + ConnectionResetError aren't URLError subclasses
            # in Py 3.10+; ditto generic OSError on flaky DNS. All transient.
            log.error(
                "%s: %s %s on attempt %d/%d",
                label, type(e).__name__, e, attempt, MAX_ATTEMPTS,
            )
            time.sleep(delay)
            delay *= 2
    return None


def list_snapshots(start: date, end: date) -> list[dict[str, str]]:
    """Query CDX, return list of dicts with timestamp + original."""
    url = CDX_URL.format(
        start=start.strftime("%Y%m%d"),
        end=end.strftime("%Y%m%d"),
    )
    log.info("CDX query: %s", url)
    raw = fetch_with_retry(url, "CDX")
    if raw is None:
        log.error("CDX query failed; aborting")
        sys.exit(1)
    rows = json.loads(raw)
    if not rows:
        log.error("CDX returned no rows")
        return []
    headers, *records = rows
    keys = {name: i for i, name in enumerate(headers)}
    out: list[dict[str, str]] = []
    for r in records:
        out.append({
            "timestamp": r[keys["timestamp"]],
            "original": r[keys["original"]],
            "digest": r[keys["digest"]],
        })
    log.info("CDX returned %d unique snapshots", len(out))
    return out


def pick_biweekly(
    snaps: list[dict[str, str]],
    start: date,
    end: date,
) -> list[dict[str, str]]:
    """Bucket into WINDOW_DAYS windows; per-window pick the snapshot
    closest to the window midpoint."""
    by_window: dict[date, list[tuple[float, dict[str, str]]]] = {}
    for s in snaps:
        ts = datetime.strptime(s["timestamp"][:8], "%Y%m%d").date()
        window_idx = (ts - start).days // WINDOW_DAYS
        window_start = start + timedelta(days=window_idx * WINDOW_DAYS)
        midpoint = window_start + timedelta(days=WINDOW_DAYS / 2)
        by_window.setdefault(window_start, []).append(
            (abs((ts - midpoint).days), s),
        )
    chosen: list[dict[str, str]] = []
    for window_start in sorted(by_window):
        if window_start > end:
            break
        # Sort by distance ascending — pick closest to midpoint.
        by_window[window_start].sort(key=lambda x: x[0])
        chosen.append(by_window[window_start][0][1])
    log.info(
        "Bucketed %d snapshots into %d biweekly windows",
        len(snaps), len(chosen),
    )
    return chosen


def load_manifest() -> dict[str, Any]:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text())
    return {}


def save_manifest(manifest: dict[str, Any]) -> None:
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=True))


def main() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    today = date.today()
    snaps = list_snapshots(START_DATE, today)
    chosen = pick_biweekly(snaps, START_DATE, today)

    manifest = load_manifest()
    downloaded = 0
    skipped = 0
    failed = 0

    for i, s in enumerate(chosen, 1):
        ts = s["timestamp"]
        date_key = ts[:8]
        out_path = RAW_DIR / f"{date_key}.html"

        if out_path.exists() and out_path.stat().st_size > 0:
            skipped += 1
            log.info(
                "[%d/%d] %s SKIP (already on disk, %d bytes)",
                i, len(chosen), date_key, out_path.stat().st_size,
            )
            manifest[date_key] = {
                "url": WAYBACK_TEMPLATE.format(ts=ts, url=s["original"]),
                "status": "skipped",
                "bytes": out_path.stat().st_size,
            }
            continue

        url = WAYBACK_TEMPLATE.format(ts=ts, url=s["original"])
        time.sleep(REQUEST_DELAY)
        body = fetch_with_retry(url, f"snapshot {date_key}")
        if body is None:
            failed += 1
            manifest[date_key] = {"url": url, "status": "failed", "bytes": 0}
            save_manifest(manifest)
            continue

        out_path.write_bytes(body)
        downloaded += 1
        manifest[date_key] = {
            "url": url,
            "status": "ok",
            "bytes": len(body),
        }
        if i % 10 == 0 or i == len(chosen):
            save_manifest(manifest)
            log.info(
                "[%d/%d] %s OK %dKB  (downloaded=%d skipped=%d failed=%d)",
                i, len(chosen), date_key, len(body) // 1024,
                downloaded, skipped, failed,
            )
        else:
            log.info(
                "[%d/%d] %s OK %dKB",
                i, len(chosen), date_key, len(body) // 1024,
            )

    save_manifest(manifest)
    log.info(
        "DONE — total=%d downloaded=%d skipped=%d failed=%d",
        len(chosen), downloaded, skipped, failed,
    )
    if failed > 0.2 * len(chosen):
        log.error(
            "FAILURE RATE >20%% (%d/%d) — review before parsing",
            failed, len(chosen),
        )
        sys.exit(2)


if __name__ == "__main__":
    main()

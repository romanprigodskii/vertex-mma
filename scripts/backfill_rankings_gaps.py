#!/usr/bin/env python3
"""One-off backfill for ufc.com/rankings months that came back empty in
the biweekly main scrape.

Usage:
    python3 scripts/backfill_rankings_gaps.py 2019-03 2019-06

For each YYYY-MM argument, queries CDX for that month + ±5-day buffer on
either side, picks up to 2 snapshots (mid-month + late-month), downloads
them as imports/ufc_rankings_raw/YYYYMMDD.html, and updates _manifest.json.
Reuses fetch_with_retry from scrape_ufc_rankings.
"""
from __future__ import annotations

import calendar
import json
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
# Reuse the main scraper's helpers — same retry/backoff, same UA, same logger.
from scrape_ufc_rankings import (  # noqa: E402
    CDX_URL,
    MANIFEST_PATH,
    RAW_DIR,
    REQUEST_DELAY,
    WAYBACK_TEMPLATE,
    fetch_with_retry,
    load_manifest,
    log,
    save_manifest,
)
import time  # noqa: E402


def ym_to_range(ym: str, buffer_days: int = 5) -> tuple[date, date]:
    """'2019-03' → (2019-02-24, 2019-04-05)."""
    y, m = ym.split("-")
    yi, mi = int(y), int(m)
    last_day = calendar.monthrange(yi, mi)[1]
    start = date(yi, mi, 1) - timedelta(days=buffer_days)
    end = date(yi, mi, last_day) + timedelta(days=buffer_days)
    return start, end


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: backfill_rankings_gaps.py YYYY-MM [YYYY-MM ...]")
        sys.exit(1)

    manifest = load_manifest()
    total_downloaded = 0

    for ym in sys.argv[1:]:
        start, end = ym_to_range(ym)
        url = CDX_URL.format(
            start=start.strftime("%Y%m%d"), end=end.strftime("%Y%m%d"),
        )
        log.info("backfill %s: CDX query %s", ym, url)
        raw = fetch_with_retry(url, f"CDX {ym}")
        if raw is None:
            log.error("backfill %s: CDX failed", ym)
            continue
        rows = json.loads(raw)
        if not rows or len(rows) < 2:
            log.warning("backfill %s: CDX returned no records", ym)
            continue
        _headers, *records = rows
        # Pick 2 snapshots: closest to day 14 and closest to day 28.
        targets = [date(int(ym.split("-")[0]), int(ym.split("-")[1]), 14),
                   date(int(ym.split("-")[0]), int(ym.split("-")[1]), 28)]
        snap_dates = []
        for record in records:
            ts = record[1]
            sd = date(int(ts[0:4]), int(ts[4:6]), int(ts[6:8]))
            snap_dates.append((sd, ts, record[2]))
        for tgt in targets:
            best = min(snap_dates, key=lambda s: abs((s[0] - tgt).days))
            ts, original = best[1], best[2]
            date_key = ts[:8]
            out_path = RAW_DIR / f"{date_key}.html"
            if out_path.exists() and out_path.stat().st_size > 0:
                log.info("backfill %s: %s already on disk, skip", ym, date_key)
                continue
            full_url = WAYBACK_TEMPLATE.format(ts=ts, url=original)
            time.sleep(REQUEST_DELAY)
            body = fetch_with_retry(full_url, f"backfill {date_key}")
            if body is None:
                log.error("backfill %s: %s download failed", ym, date_key)
                continue
            out_path.write_bytes(body)
            manifest[date_key] = {
                "url": full_url, "status": "ok", "bytes": len(body),
            }
            total_downloaded += 1
            log.info(
                "backfill %s: %s OK %dKB", ym, date_key, len(body) // 1024,
            )

    save_manifest(manifest)
    log.info("backfill done — %d new files", total_downloaded)


if __name__ == "__main__":
    main()

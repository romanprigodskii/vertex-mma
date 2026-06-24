#!/usr/bin/env python3
"""Fetch the LIVE ufc.com/rankings page and drop it into the same raw dir the
Wayback scraper uses, so the existing parse → import chain picks it up as
*today's* snapshot — no Archive.org lag.

ufc.com/rankings is server-rendered (the rank tables are in the initial HTML,
not JS-hydrated), so a plain GET + the existing parse_modern() in
parse_ufc_rankings.py handles it. We just save it as
imports/ufc_rankings_raw/{YYYYMMDD}.html and let parse derive the date from the
filename.

Idempotent: overwrites today's file on each run (rankings can change intra-day
on update days). Polite UA, retry with backoff. Stdlib only.

Usage:
    python3 scripts/fetch_ufc_rankings_live.py
"""
from __future__ import annotations

import logging
import sys
import time
from datetime import date
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "imports" / "ufc_rankings_raw"
URL = "https://www.ufc.com/rankings"
USER_AGENT = "Mozilla/5.0 vertex-mma-research (rankings infrastructure)"
TIMEOUT = 30
MAX_ATTEMPTS = 4
# Server-rendered sanity markers — if these are absent the page didn't render
# the tables (geo-block / JS shell / markup change) and we must NOT overwrite a
# good prior snapshot with junk.
REQUIRED_MARKERS = (b"view-grouping-header", b"views-field-weight-class-rank")
MIN_BYTES = 50_000

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)
log = logging.getLogger("fetch_rankings_live")


def fetch() -> bytes:
    last: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            req = Request(URL, headers={"User-Agent": USER_AGENT})
            with urlopen(req, timeout=TIMEOUT) as resp:
                if resp.status != 200:
                    raise URLError(f"HTTP {resp.status}")
                return resp.read()
        except (HTTPError, URLError, TimeoutError) as exc:
            last = exc
            wait = 2 ** attempt
            log.warning("attempt %d/%d failed: %r — retry in %ds",
                        attempt, MAX_ATTEMPTS, exc, wait)
            time.sleep(wait)
    raise SystemExit(f"giving up after {MAX_ATTEMPTS} attempts: {last!r}")


def main() -> int:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    body = fetch()
    if len(body) < MIN_BYTES or not all(m in body for m in REQUIRED_MARKERS):
        raise SystemExit(
            f"fetched {len(body)} bytes but rank markers missing — "
            "refusing to overwrite snapshot with a non-rendered page"
        )
    out = RAW_DIR / f"{date.today():%Y%m%d}.html"
    out.write_bytes(body)
    log.info("wrote %s (%d bytes) — live ufc.com/rankings snapshot", out, len(body))
    return 0


if __name__ == "__main__":
    sys.exit(main())

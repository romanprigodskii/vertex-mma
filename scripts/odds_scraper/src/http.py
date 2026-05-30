"""Polite HTTP fetcher for bestfightodds. Rate-limited, retries on
transient failures, common browser UA."""

from __future__ import annotations

import asyncio
import time

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0; rv:121.0) Gecko/20100101 Firefox/121.0"
)
BASE_URL = "https://www.bestfightodds.com"
REQUEST_TIMEOUT = 20.0
MIN_INTERVAL_SECONDS = 1.0  # ~1 req/s, polite to bestfightodds


class RateLimitedClient:
    """httpx.Client wrapper that enforces a minimum gap between requests."""

    def __init__(self, min_interval: float = MIN_INTERVAL_SECONDS) -> None:
        self._client = httpx.Client(
            base_url=BASE_URL,
            timeout=REQUEST_TIMEOUT,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"},
            follow_redirects=True,
            http2=True,
        )
        self.min_interval = min_interval
        self._last_request_ts: float = 0.0

    def _maybe_sleep(self) -> None:
        elapsed = time.monotonic() - self._last_request_ts
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self._last_request_ts = time.monotonic()

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=2, max=10))
    def get(self, path: str) -> httpx.Response:
        self._maybe_sleep()
        return self._client.get(path)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "RateLimitedClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

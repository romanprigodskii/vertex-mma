from __future__ import annotations

import time
from typing import Optional

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from .config import (
    MAX_RETRIES,
    RATE_LIMIT_SECONDS,
    REQUEST_TIMEOUT,
    RETRY_BACKOFF_BASE,
    USER_AGENT,
)
from .utils.logger import log


class RetryableHTTPError(Exception):
    """Raised for 429/5xx — tenacity retries on this only."""


class Client:
    """Sequential, rate-limited HTTP client with retries on 429/5xx."""

    def __init__(self, *, rate_limit_seconds: float = RATE_LIMIT_SECONDS):
        self._client = httpx.Client(
            timeout=REQUEST_TIMEOUT,
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
            http2=True,
        )
        self._rate_limit = rate_limit_seconds
        self._last_request_ts = 0.0

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _throttle(self) -> None:
        delta = time.monotonic() - self._last_request_ts
        if delta < self._rate_limit:
            time.sleep(self._rate_limit - delta)
        self._last_request_ts = time.monotonic()

    @retry(
        retry=retry_if_exception_type(RetryableHTTPError),
        stop=stop_after_attempt(MAX_RETRIES),
        wait=wait_exponential(multiplier=RETRY_BACKOFF_BASE, min=1, max=30),
        reraise=True,
    )
    def get(self, url: str) -> str:
        self._throttle()
        start = time.monotonic()
        try:
            response = self._client.get(url)
        except httpx.HTTPError as exc:
            log.warning(f"transport error for {url}: {exc!r} — will retry")
            raise RetryableHTTPError(str(exc)) from exc

        elapsed_ms = int((time.monotonic() - start) * 1000)
        status = response.status_code

        if status == 429 or status >= 500:
            log.warning(f"GET {url} -> {status} in {elapsed_ms}ms — will retry")
            raise RetryableHTTPError(f"status {status}")

        if status >= 400:
            log.error(f"GET {url} -> {status} in {elapsed_ms}ms — giving up")
            response.raise_for_status()

        log.debug(f"GET {url} -> {status} in {elapsed_ms}ms")
        return response.text


def fetch(url: str, *, client: Optional[Client] = None) -> str:
    """Convenience for one-off fetches."""
    if client is not None:
        return client.get(url)
    with Client() as c:
        return c.get(url)

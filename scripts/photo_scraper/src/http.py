from __future__ import annotations

import time

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from .config import MAX_RETRIES, RATE_LIMIT_SECONDS, REQUEST_TIMEOUT, RETRY_BACKOFF_BASE, USER_AGENT
from .utils.logger import log


class RetryableHTTPError(Exception):
    pass


class Client:
    def __init__(self, *, rate_limit_seconds: float = RATE_LIMIT_SECONDS):
        self._client = httpx.Client(
            timeout=REQUEST_TIMEOUT,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"},
            follow_redirects=True,
            http2=True,
        )
        self._rate_limit = rate_limit_seconds
        self._last_ts = 0.0

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _throttle(self) -> None:
        delta = time.monotonic() - self._last_ts
        if delta < self._rate_limit:
            time.sleep(self._rate_limit - delta)
        self._last_ts = time.monotonic()

    @retry(
        retry=retry_if_exception_type(RetryableHTTPError),
        stop=stop_after_attempt(MAX_RETRIES),
        wait=wait_exponential(multiplier=RETRY_BACKOFF_BASE, min=1, max=30),
        reraise=True,
    )
    def get(self, url: str, *, params: dict | None = None) -> httpx.Response:
        self._throttle()
        try:
            response = self._client.get(url, params=params)
        except httpx.HTTPError as exc:
            log.warning(f"transport error for {url}: {exc!r}")
            raise RetryableHTTPError(str(exc)) from exc

        if response.status_code == 429 or response.status_code >= 500:
            log.warning(f"GET {url} -> {response.status_code} — retrying")
            raise RetryableHTTPError(f"status {response.status_code}")
        return response

    def get_bytes(self, url: str) -> bytes:
        response = self.get(url)
        if response.status_code >= 400:
            response.raise_for_status()
        return response.content

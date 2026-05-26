from __future__ import annotations

import hashlib
import re
import time
from typing import Optional
from urllib.parse import urlparse, urlunparse

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


# In May 2026 ufcstats.com put a JS proof-of-work interstitial in front of
# /fight-details. The page returns 200 with a SHA-256 PoW script; once the
# browser computes a nonce that hashes to N leading zeros and POSTs it to
# /__c, the server sets a cookie and the real page becomes reachable.
# Detect → solve → submit → retry handles it in pure Python.
_CHALLENGE_NONCE_RX = re.compile(r'var\s+nonce\s*=\s*"([^"]+)"')
_CHALLENGE_TARGET_RX = re.compile(
    r"new\s+Array\(\s*(\d+)\s*\+\s*1\s*\)\.join\(\s*['\"]0['\"]\s*\)"
)


def _is_pow_challenge(text: str) -> bool:
    return (
        len(text) < 8_000
        and "Checking your browser" in text
        and _CHALLENGE_NONCE_RX.search(text) is not None
    )


def _solve_pow(nonce: str, target_len: int) -> str:
    """Find n such that sha256(nonce + ':' + n)[:target_len] is all zeros.
    target_len is 2 in current deployments → ~256 iterations on average."""
    target = "0" * target_len
    n = 0
    while True:
        h = hashlib.sha256(f"{nonce}:{n}".encode()).hexdigest()
        if h.startswith(target):
            return str(n)
        n += 1


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

    def _solve_challenge(self, url: str, body: str) -> bool:
        """Solve the inline PoW and POST the answer to /__c on the same
        origin. Returns True when the cookie was successfully set."""
        nonce_match = _CHALLENGE_NONCE_RX.search(body)
        target_match = _CHALLENGE_TARGET_RX.search(body)
        if not nonce_match or not target_match:
            return False
        nonce = nonce_match.group(1)
        target_len = int(target_match.group(1))
        n = _solve_pow(nonce, target_len)

        parsed = urlparse(url)
        submit_url = urlunparse(
            (parsed.scheme, parsed.netloc, "/__c", "", "", "")
        )
        try:
            resp = self._client.post(
                submit_url,
                data={"nonce": nonce, "n": n},
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Referer": url,
                },
            )
        except httpx.HTTPError as exc:
            log.warning(f"PoW submit failed for {submit_url}: {exc!r}")
            return False
        if resp.status_code >= 300:
            log.warning(
                f"PoW submit returned {resp.status_code} — cookie not set"
            )
            return False
        log.info(f"PoW solved for {parsed.netloc} (n={n})")
        return True

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

        # PoW interstitial — solve and retry once. The cookie sticks on the
        # httpx Client so subsequent requests skip the interstitial entirely.
        if status == 200 and _is_pow_challenge(response.text):
            if self._solve_challenge(url, response.text):
                response = self._client.get(url)
                status = response.status_code

        log.debug(f"GET {url} -> {status} in {elapsed_ms}ms")
        return response.text


def fetch(url: str, *, client: Optional[Client] = None) -> str:
    """Convenience for one-off fetches."""
    if client is not None:
        return client.get(url)
    with Client() as c:
        return c.get(url)

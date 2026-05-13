from __future__ import annotations

import os
import urllib.parse
from pathlib import Path

import psycopg
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(PROJECT_ROOT / ".env.local")

DATABASE_URL = os.environ.get("DATABASE_URL")
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set. Populate .env.local at the project root.")


def _patch_connection_string_for_dns(url: str) -> str:
    """Append ?hostaddr=<resolved IP> to the URL so libpq skips system DNS.

    libpq does its own getaddrinfo and ignores Python's socket override. When the
    host's primary nameserver is broken (current state), connect() hangs. We
    resolve the host via our DNS override (which uses 1.1.1.1) and pass the IP
    directly as `hostaddr` — libpq then opens a TCP connection to that IP and
    still uses `host` for TLS SNI / authentication.
    """
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname
    if not host:
        return url
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if "hostaddr" in query:
        return url
    try:
        from .dns_override import resolve

        ips = resolve(host)
    except Exception:  # noqa: BLE001 — fall back to system DNS on failure
        return url
    if not ips:
        return url
    query["hostaddr"] = [ips[0]]
    new_query = urllib.parse.urlencode(query, doseq=True)
    return urllib.parse.urlunparse(parsed._replace(query=new_query))


def get_connection() -> psycopg.Connection:
    return psycopg.connect(_patch_connection_string_for_dns(DATABASE_URL), autocommit=False)

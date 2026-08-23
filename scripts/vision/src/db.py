"""Postgres connection — same DNS-override workaround as scripts/simulation."""

from __future__ import annotations

import os
import socket
import urllib.parse
from pathlib import Path

import psycopg
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(PROJECT_ROOT / ".env.local")

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. Populate .env.local at the project root."
    )


def _patch_connection_string_for_dns(url: str) -> str:
    """Append ?hostaddr=<resolved IP> so libpq skips system DNS."""
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname
    if not host:
        return url
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if "hostaddr" in query:
        return url
    try:
        infos = socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)
    except OSError:
        return url
    ips = [i[4][0] for i in infos]
    if not ips:
        return url
    query["hostaddr"] = [ips[0]]
    return urllib.parse.urlunparse(
        parsed._replace(query=urllib.parse.urlencode(query, doseq=True))
    )


def get_connection() -> psycopg.Connection:
    return psycopg.connect(
        _patch_connection_string_for_dns(DATABASE_URL),
        autocommit=False,
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=5,
    )

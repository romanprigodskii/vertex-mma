"""Workaround for a broken system DNS path.

The host system's primary nameservers (8.8.8.8 in our case) are timing out from
this network, but 1.1.1.1 / 9.9.9.9 are reachable. Python's `socket.getaddrinfo`
goes through the system resolver and therefore inherits the failure.

To keep the scraper working until system DNS recovers, we:

1. Query an alternate set of nameservers directly over UDP (raw 53/udp DNS
   wire protocol — no `dnspython` dependency, which we couldn't install while
   DNS was down).
2. Cache the answers in-process.
3. Monkey-patch `socket.getaddrinfo` to consult the cache before falling back
   to the original implementation.

The override is opt-in — call `install()` once at process start. It is a no-op
on any host where the system resolver works first try, since the original
function is tried after the cache miss path.
"""

from __future__ import annotations

import random
import socket
import struct
import threading
from typing import Iterable

# Cloudflare, Quad9, Google as fallbacks in that order. Google is included
# because in many networks it works fine even though it's broken on ours today.
FALLBACK_NAMESERVERS: tuple[str, ...] = ("1.1.1.1", "9.9.9.9", "8.8.4.4")

# Hosts we *know* we'll need. Resolving these eagerly catches the failure
# at startup instead of mid-run.
PRELOAD_HOSTS: tuple[str, ...] = (
    "en.wikipedia.org",
    "www.wikidata.org",
    "commons.wikimedia.org",
    "upload.wikimedia.org",
)

_cache: dict[str, list[str]] = {}
_cache_lock = threading.Lock()
_original_getaddrinfo = socket.getaddrinfo
_installed = False


def _encode_name(name: str) -> bytes:
    parts = name.rstrip(".").split(".")
    out = bytearray()
    for label in parts:
        encoded = label.encode("ascii")
        if len(encoded) > 63:
            raise ValueError(f"DNS label too long: {label!r}")
        out.append(len(encoded))
        out.extend(encoded)
    out.append(0)
    return bytes(out)


def _build_query(name: str, *, qtype: int = 1) -> tuple[bytes, int]:
    tx = random.randint(0, 0xFFFF)
    header = struct.pack(">HHHHHH", tx, 0x0100, 1, 0, 0, 0)
    question = _encode_name(name) + struct.pack(">HH", qtype, 1)
    return header + question, tx


def _parse_name(data: bytes, offset: int) -> tuple[str, int]:
    labels: list[str] = []
    while True:
        if offset >= len(data):
            break
        length = data[offset]
        if length == 0:
            offset += 1
            break
        if length & 0xC0 == 0xC0:
            # Pointer (compression). We don't actually need the name itself
            # for our use-case beyond consuming bytes, but follow it for
            # completeness.
            ptr = ((length & 0x3F) << 8) | data[offset + 1]
            ptr_name, _ = _parse_name(data, ptr)
            labels.append(ptr_name)
            offset += 2
            break
        offset += 1
        labels.append(data[offset : offset + length].decode("ascii", "replace"))
        offset += length
    return ".".join(labels), offset


def _resolve_via(server: str, name: str, *, timeout: float = 3.0) -> list[str]:
    query, tx = _build_query(name)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(query, (server, 53))
        data, _ = sock.recvfrom(4096)
    finally:
        sock.close()

    if len(data) < 12:
        return []
    resp_tx, _flags, qd, an, _ns, _ar = struct.unpack(">HHHHHH", data[:12])
    if resp_tx != tx:
        return []
    offset = 12
    for _ in range(qd):
        _, offset = _parse_name(data, offset)
        offset += 4  # QTYPE + QCLASS

    ips: list[str] = []
    for _ in range(an):
        _, offset = _parse_name(data, offset)
        rtype, _rclass, _ttl, rdlen = struct.unpack(">HHIH", data[offset : offset + 10])
        offset += 10
        rdata = data[offset : offset + rdlen]
        offset += rdlen
        if rtype == 1 and rdlen == 4:  # A
            ips.append(".".join(str(b) for b in rdata))
        # We intentionally ignore AAAA/CNAME bookkeeping — IPv4 is enough.
    return ips


def resolve(host: str, *, nameservers: Iterable[str] = FALLBACK_NAMESERVERS) -> list[str]:
    """Resolve `host` to a list of IPv4 strings. Tries `nameservers` in order."""
    with _cache_lock:
        cached = _cache.get(host)
    if cached:
        return cached

    last_err: Exception | None = None
    for ns in nameservers:
        try:
            ips = _resolve_via(ns, host)
            if ips:
                with _cache_lock:
                    _cache[host] = ips
                return ips
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            continue
    if last_err:
        raise last_err
    return []


def _patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):  # type: ignore[no-untyped-def]
    if isinstance(host, str) and host and not host.replace(".", "").isdigit():
        try:
            return _original_getaddrinfo(host, port, family, type, proto, flags)
        except socket.gaierror:
            try:
                ips = resolve(host)
            except Exception:  # noqa: BLE001
                raise
            if not ips:
                raise
            sock_type = type or socket.SOCK_STREAM
            return [
                (socket.AF_INET, sock_type, proto or 0, "", (ip, port))
                for ip in ips
            ]
    return _original_getaddrinfo(host, port, family, type, proto, flags)


def install(preload: bool = True) -> None:
    """Install the override. Idempotent."""
    global _installed
    if _installed:
        return
    socket.getaddrinfo = _patched_getaddrinfo  # type: ignore[assignment]
    _installed = True
    if preload:
        for host in PRELOAD_HOSTS:
            try:
                resolve(host)
            except Exception:  # noqa: BLE001
                # Cache miss is OK — the on-demand path will try again.
                pass

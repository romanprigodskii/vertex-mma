from __future__ import annotations

import httpx

from .config import STORAGE_BUCKET
from .db import SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL
from .utils.logger import log


class StorageError(RuntimeError):
    pass


def _require_creds() -> tuple[str, str]:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise StorageError(
            "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local"
        )
    return SUPABASE_URL.rstrip("/"), SUPABASE_SERVICE_ROLE_KEY


def upload(path: str, *, content: bytes, content_type: str = "image/webp") -> str:
    """Upsert an object into the public fighter-photos bucket. Returns its public URL."""
    base, key = _require_creds()
    url = f"{base}/storage/v1/object/{STORAGE_BUCKET}/{path}"
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": content_type,
        # Overwrite if it already exists.
        "x-upsert": "true",
    }
    response = httpx.post(url, headers=headers, content=content, timeout=30.0)
    if response.status_code >= 400:
        log.error(f"storage upload failed for {path}: {response.status_code} {response.text[:200]}")
        raise StorageError(f"upload {path} -> {response.status_code}")
    return public_url(path)


def public_url(path: str) -> str:
    base, _ = _require_creds()
    return f"{base}/storage/v1/object/public/{STORAGE_BUCKET}/{path}"

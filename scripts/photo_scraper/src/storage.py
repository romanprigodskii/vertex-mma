from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from .config import (
    PHOTO_PUBLIC_BASE,
    PHOTO_REMOTE_HOST,
    PHOTO_REMOTE_ROOT,
    PHOTO_SSH_KEY,
    PHOTO_STORE_DIR,
    STORAGE_BUCKET,
)
from .utils.logger import log


class StorageError(RuntimeError):
    pass


def store_root() -> Path:
    """The local tree that mirrors what the origin serves, one dir per fighter."""
    return Path(PHOTO_STORE_DIR).expanduser() / STORAGE_BUCKET


def local_path(path: str) -> Path:
    return store_root() / path


def upload(path: str, *, content: bytes, content_type: str = "image/webp") -> str:
    """Write an object into the local photo store. Returns its public URL.

    Photos used to go straight into a Supabase storage bucket over HTTP. That
    project is gone, so the store is now a plain directory on disk that
    `publish()` rsyncs to the nginx origin on the VPS — ufc.com blocks the
    datacenter IP, so the fetch has to happen here and the bytes have to travel.
    `content_type` is kept in the signature because callers pass it; nginx
    types the file from its extension.
    """
    del content_type
    dest = local_path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    try:
        tmp.write_bytes(content)
        tmp.replace(dest)  # atomic, so a half-written file is never served
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise StorageError(f"write {dest} -> {exc!r}") from exc
    return public_url(path)


def public_url(path: str) -> str:
    return f"{PHOTO_PUBLIC_BASE.rstrip('/')}/{path.lstrip('/')}"


def publish(*, dry_run: bool = False) -> None:
    """Rsync the local store to the origin. Additive: never deletes remote files,
    so a partial run can't wipe photos it simply didn't refetch this time."""
    if shutil.which("rsync") is None:
        raise StorageError("rsync is not installed — cannot publish the photo store")
    root = store_root()
    if not root.is_dir():
        raise StorageError(f"nothing to publish: {root} does not exist")

    cmd = [
        "rsync",
        "-az",
        # --stats, not --info=stats1: macOS still ships rsync 2.6.9, which
        # predates --info entirely, and the fetch has to run from a Mac.
        "--stats",
        "-e",
        f"ssh -i {PHOTO_SSH_KEY} -o StrictHostKeyChecking=accept-new",
        f"{root}/",
        f"{PHOTO_REMOTE_HOST}:{PHOTO_REMOTE_ROOT}/{STORAGE_BUCKET}/",
    ]
    if dry_run:
        cmd.insert(1, "--dry-run")
    log.info(f"publishing {root} → {PHOTO_REMOTE_HOST}:{PHOTO_REMOTE_ROOT}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise StorageError(f"rsync failed ({result.returncode}): {result.stderr[:400]}")
    log.info(result.stdout.strip() or "published")


def store_is_configured() -> bool:
    return bool(os.environ.get("PHOTO_STORE_DIR") or PHOTO_STORE_DIR)

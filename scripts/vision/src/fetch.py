"""Video acquisition and normalisation.

Two steps, deliberately separate. `download` pulls the source once and
keeps it; `normalise` decimates it to the frame rate and resolution the
pose model actually consumes. Decimating with ffmpeg rather than
skipping frames in the inference loop is most of the speed of this
pipeline — the decoder does the throwing-away, in C, once, instead of
Python decoding thirty frames to use five.

Neither step is the expensive one. Pose is. Both outputs are caches and
both are safe to delete.
"""

from __future__ import annotations

import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data"
VIDEO_DIR = DATA / "video"
NORM_DIR = DATA / "normalised"

# 5 fps is a judgement call, and the one most likely to be revisited.
# A jab lands in ~120 ms, so 5 fps cannot see individual strikes — but
# the gate measures *configuration* (where the bodies are relative to
# each other), which changes on the scale of seconds, not milliseconds.
# Raising this is the first thing to try if the gate passes and strike
# level features are wanted.
TARGET_FPS = 5
TARGET_HEIGHT = 720

# YouTube refuses anonymous downloads outright ("sign in to confirm
# you're not a bot"), so a cookie jar is not optional. Read it from a
# FILE rather than from the browser: --cookies-from-browser needs the
# macOS keychain on every single invocation, which cannot run unattended
# and, if waved through with "always allow", leaves a standing grant on
# Chrome Safe Storage for anything running as this user. One export, one
# approval, no residue.
#
# The path is an env var and the file lives outside the repo because it
# IS a live session credential. Never commit it, never log it.
COOKIES_ENV = "VERTEX_YT_COOKIES"

# Forty sequential requests from one address is what tripped the bot
# check in the first place. Pace them.
SLEEP_MIN_SECONDS = 4
SLEEP_MAX_SECONDS = 11


def _binary(name: str) -> str:
    """Resolve a helper binary, preferring the one beside this interpreter.

    pip and uv install console scripts into the venv's bin/, which is on
    PATH for an activated shell but NOT for a subprocess launched from a
    venv interpreter invoked by absolute path — which is exactly how this
    runs on the GPU box. Looking next to sys.executable first costs
    nothing locally and is the difference between working and not there.
    """
    local = Path(sys.executable).parent / name
    if local.exists():
        return str(local)
    found = shutil.which(name)
    if found:
        return found
    raise FileNotFoundError(
        f"{name} not found beside {sys.executable} or on PATH"
    )


def _cookie_args() -> list[str]:
    path = os.environ.get(COOKIES_ENV)
    if not path:
        return []
    if not Path(path).exists():
        raise FileNotFoundError(f"{COOKIES_ENV}={path} does not exist")
    return ["--cookies", path]


def polite_pause() -> None:
    time.sleep(random.uniform(SLEEP_MIN_SECONDS, SLEEP_MAX_SECONDS))


def video_path(video_id: str) -> Path:
    return VIDEO_DIR / f"{video_id}.mp4"


def normalised_path(video_id: str) -> Path:
    return NORM_DIR / f"{video_id}_{TARGET_FPS}fps_{TARGET_HEIGHT}p.mp4"


def download(video_id: str, *, overwrite: bool = False) -> Path:
    """Fetch one upload at <=720p. Idempotent; returns the cached path."""
    out = video_path(video_id)
    if out.exists() and not overwrite:
        return out
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    cmd = [
        _binary("yt-dlp"),
        "-f", f"bestvideo[height<={TARGET_HEIGHT}]+bestaudio/best[height<={TARGET_HEIGHT}]",
        "--merge-output-format", "mp4",
        "--no-playlist",
        "--retries", "3",
        *_cookie_args(),
        "-o", str(out),
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not out.exists():
        raise RuntimeError(f"yt-dlp failed for {video_id}: {proc.stderr[-500:]}")
    return out


def normalise(video_id: str, *, overwrite: bool = False) -> Path:
    """Decimate to TARGET_FPS and scale to TARGET_HEIGHT."""
    src = video_path(video_id)
    if not src.exists():
        raise FileNotFoundError(f"{src} — download first")
    out = normalised_path(video_id)
    if out.exists() and not overwrite:
        return out
    NORM_DIR.mkdir(parents=True, exist_ok=True)
    cmd = [
        _binary("ffmpeg"), "-y", "-loglevel", "error",
        "-i", str(src),
        "-vf", f"fps={TARGET_FPS},scale=-2:{TARGET_HEIGHT}",
        "-an",                      # audio is dead weight here
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not out.exists():
        raise RuntimeError(f"ffmpeg failed for {video_id}: {proc.stderr[-500:]}")
    return out


def prepare(video_id: str) -> Path:
    """download + normalise, returning the file pose.py should read."""
    download(video_id)
    return normalise(video_id)

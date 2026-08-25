"""How many full fights does the UFC channel actually hold?

bout_video's 110 rows came from a single search, truncated at 400
results. That is a sample, not a census, and the difference decides
whether this project needs a Fight Pass subscription at all: the corpus
is currently too shallow to test anything (99 of 147 fighters appear in
exactly one bout), and YouTube is the only source with no geography, no
subscription and a pipeline already pointed at it.

Enumeration is metadata only — a few MB, no video — so the census is
close to free either way the answer comes out.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"

# The UFC files full bouts under several long-running series, and a
# single query catches only one of them.
SOURCES = [
    ("search:FULL FIGHT", "https://www.youtube.com/@UFC/search?query=FULL%20FIGHT"),
    ("search:Free Fight", "https://www.youtube.com/@UFC/search?query=Free%20Fight"),
    ("search:UFC Classics", "https://www.youtube.com/@UFC/search?query=UFC%20Classics"),
    ("search:UFC Debut", "https://www.youtube.com/@UFC/search?query=UFC%20Debut"),
    ("search:Fight Night", "https://www.youtube.com/@UFC/search?query=Fight%20Night%20full%20fight"),
    ("search:vs", "https://www.youtube.com/@UFC/search?query=vs%20full%20fight"),
    ("playlists", "https://www.youtube.com/@UFC/playlists"),
]

# Individual bouts run roughly 3-30 minutes once walkouts are included.
# Below that it is a highlight; above it, a marathon compilation.
MIN_SECONDS = 180
MAX_SECONDS = 2400

FIGHT_MARKERS = ("full fight", "free fight", "ufc classic", "ufc debut")
VS = re.compile(r"\bvs\.?\b", re.IGNORECASE)


def enumerate_source(url: str, limit: int) -> list[dict]:
    cmd = ["yt-dlp", "--flat-playlist", "--playlist-end", str(limit),
           "--print", "%(id)s\t%(duration)s\t%(title)s", "--no-warnings"]
    jar = os.environ.get("VERTEX_YT_COOKIES")
    if jar and Path(jar).exists():
        cmd += ["--cookies", jar]
    cmd.append(url)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    out = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        vid, dur, title = parts
        out.append({"id": vid, "duration": dur, "title": title})
    return out


def looks_like_a_fight(row: dict) -> bool:
    title = row["title"].lower()
    if not any(m in title for m in FIGHT_MARKERS):
        return False
    if not VS.search(row["title"]):
        return False
    try:
        secs = int(float(row["duration"]))
    except (TypeError, ValueError):
        return False
    return MIN_SECONDS <= secs <= MAX_SECONDS


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=800,
                    help="entries pulled per source before filtering")
    args = ap.parse_args()

    seen: dict[str, dict] = {}
    per_source = {}
    for name, url in SOURCES:
        rows = enumerate_source(url, args.limit)
        kept = 0
        for r in rows:
            if looks_like_a_fight(r) and r["id"] not in seen:
                seen[r["id"]] = r
                kept += 1
        per_source[name] = {"returned": len(rows), "new_fights": kept}
        print(f"{name:24} returned {len(rows):5d}   new fights {kept:4d}   "
              f"total {len(seen):4d}", flush=True)

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    path = ARTIFACTS / "youtube_census.json"
    path.write_text(json.dumps(
        {"per_source": per_source, "fights": list(seen.values())},
        indent=2, ensure_ascii=False))
    print(f"\ndistinct full fights found: {len(seen)}")
    print(f"written: {path}")


if __name__ == "__main__":
    main()

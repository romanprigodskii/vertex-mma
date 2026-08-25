"""Walk the UFC channel's playlists, not just its search results.

The search census saturated at 182 fights: the last three queries
returned 1531 entries between them and added 34. That is what a
relevance ranking does — it keeps handing back the same well-known
bouts however you phrase the question.

A playlist is a catalogue rather than a ranking, so it can list things
search will not surface. The first pass missed this because enumerating
the playlists PAGE returns playlists, which have no duration and were
correctly thrown away by a filter built for videos. This walks into
each one.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from enumerate_youtube import ARTIFACTS, looks_like_a_fight  # noqa: E402

PLAYLISTS_URL = "https://www.youtube.com/@UFC/playlists"


def _run(url: str, limit: int, fmt: str) -> list[str]:
    cmd = ["yt-dlp", "--flat-playlist", "--playlist-end", str(limit),
           "--print", fmt, "--no-warnings", "--ignore-errors"]
    jar = os.environ.get("VERTEX_YT_COOKIES")
    if jar and Path(jar).exists():
        cmd += ["--cookies", jar]
    cmd.append(url)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return [l for l in proc.stdout.splitlines() if l.strip()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--playlists", type=int, default=200)
    ap.add_argument("--per-playlist", type=int, default=300)
    args = ap.parse_args()

    census = ARTIFACTS / "youtube_census.json"
    known = {}
    if census.exists():
        known = {f["id"]: f for f in json.loads(census.read_text())["fights"]}
    print(f"starting from {len(known)} fights found by search\n")

    ids = _run(PLAYLISTS_URL, args.playlists, "%(id)s")
    ids = [i for i in ids if i.startswith("PL") or len(i) > 20]
    print(f"playlists on the channel: {len(ids)}\n")

    added_total = 0
    for n, pid in enumerate(ids, 1):
        rows = _run(f"https://www.youtube.com/playlist?list={pid}",
                    args.per_playlist, "%(id)s\t%(duration)s\t%(title)s")
        added = 0
        for line in rows:
            parts = line.split("\t")
            if len(parts) != 3:
                continue
            row = {"id": parts[0], "duration": parts[1], "title": parts[2]}
            if row["id"] in known:
                continue
            if looks_like_a_fight(row):
                known[row["id"]] = row
                added += 1
        added_total += added
        if added or n % 10 == 0:
            print(f"[{n}/{len(ids)}] {pid[:24]}  entries {len(rows):4d}  "
                  f"new {added:3d}  total {len(known):4d}", flush=True)

    out = ARTIFACTS / "youtube_census_full.json"
    out.write_text(json.dumps({"fights": list(known.values())},
                              indent=2, ensure_ascii=False))
    print(f"\nplaylists added {added_total} fights search never showed")
    print(f"distinct full fights: {len(known)}")
    print(f"written: {out}")


if __name__ == "__main__":
    main()

"""Download -> normalise -> pose, one fight at a time, resumable.

Every step is cached on disk, so an interrupted run costs only the fight
it died on. That matters: this is hours of GPU time, not minutes.
"""

from __future__ import annotations

import argparse
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import fetch, pose  # noqa: E402
from src.manifest import read_manifest  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="stop after N fights")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--keep-video", action="store_true",
                    help="keep the source download (default: delete after pose)")
    args = ap.parse_args()

    fights = read_manifest()
    if args.limit:
        fights = fights[: args.limit]

    done = failed = 0
    for i, f in enumerate(fights, 1):
        out = pose.skeleton_path(f.youtube_video_id)
        if out.exists() and not args.overwrite:
            print(f"[{i}/{len(fights)}] cached  {f.title[:60]}")
            done += 1
            continue

        print(f"[{i}/{len(fights)}] {f.title[:60]}")
        t0 = time.time()
        try:
            normalised = fetch.prepare(f.youtube_video_id)
            pose.extract(f.youtube_video_id, normalised, overwrite=args.overwrite)
            done += 1
            if not args.keep_video:
                fetch.video_path(f.youtube_video_id).unlink(missing_ok=True)
            print(f"    ok in {time.time() - t0:.0f}s -> {out.name}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"    FAILED: {exc}")
            traceback.print_exc(limit=2)

    print(f"\ndone: {done}   failed: {failed}")


if __name__ == "__main__":
    main()

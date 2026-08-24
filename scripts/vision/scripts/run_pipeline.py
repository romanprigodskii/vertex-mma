"""Fetch in parallel, pose as the files land.

The sequential runner spends most of its wall clock waiting on YouTube:
about five minutes a fight on a home connection, against roughly six
minutes of GPU. Run them one after the other and a 35-fight set costs
the sum; overlap them and it costs the larger of the two.

Downloads are the part that parallelises — YouTube throttles per
connection, not in aggregate — so a small pool of fetchers feeds a
single pose worker. Single, deliberately: two processes writing one
skeleton parquet is a corrupt file, and the GPU is saturated by one
anyway.

Everything is cached and idempotent, so a laptop lid closing mid-run
costs only the fights that were in flight.
"""

from __future__ import annotations

import argparse
import queue
import sys
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import fetch, pose  # noqa: E402
from src.manifest import Fight, read_manifest  # noqa: E402

# Four is a compromise. One wastes the link; a dozen from a single
# address is the pattern that got us the bot check in the first place.
FETCH_WORKERS = 4

# Signals that YouTube is refusing rather than merely failing. Grinding
# through the rest of the list after these only makes the session look
# worse — the first refusal already carried the information.
BLOCK_MARKERS = ("not a bot", "Sign in to confirm", "HTTP Error 429")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--holdout", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--workers", type=int, default=FETCH_WORKERS)
    ap.add_argument("--keep-video", action="store_true")
    args = ap.parse_args()

    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "ep", Path(__file__).resolve().parent / "extract_pose.py"
    )
    ep = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ep)

    fights = read_manifest()
    if args.holdout:
        pilot = {f.youtube_video_id for f in ep._sample(fights, ep.PILOT_SIZE)}
        fights = ep._sample(fights, args.limit or 10**9, exclude=pilot)
    elif args.limit:
        fights = ep._sample(fights, args.limit)

    todo = [f for f in fights if not pose.skeleton_path(f.youtube_video_id).exists()]
    print(f"{len(fights)} fights, {len(fights) - len(todo)} already posed, {len(todo)} to do")

    fetch_q: queue.Queue[Fight | None] = queue.Queue()
    pose_q: queue.Queue[tuple[Fight, Path] | None] = queue.Queue()
    for f in todo:
        fetch_q.put(f)

    blocked = threading.Event()
    lock = threading.Lock()
    stats = {"fetched": 0, "posed": 0, "fetch_failed": 0, "pose_failed": 0}
    consecutive_blocks = [0]

    def say(msg: str) -> None:
        with lock:
            print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)

    def fetcher(n: int) -> None:
        while not blocked.is_set():
            try:
                f = fetch_q.get_nowait()
            except queue.Empty:
                return
            vid = f.youtube_video_id
            try:
                if fetch.normalised_path(vid).exists():
                    pose_q.put((f, fetch.normalised_path(vid)))
                    continue
                t0 = time.time()
                path = fetch.prepare(vid)
                with lock:
                    stats["fetched"] += 1
                    consecutive_blocks[0] = 0
                say(f"[fetch{n}] {f.title[:44]} in {time.time()-t0:.0f}s")
                pose_q.put((f, path))
            except Exception as exc:  # noqa: BLE001
                with lock:
                    stats["fetch_failed"] += 1
                message = str(exc)
                say(f"[fetch{n}] FAILED {vid}: {message[:110]}")
                if any(m in message for m in BLOCK_MARKERS):
                    with lock:
                        consecutive_blocks[0] += 1
                        if consecutive_blocks[0] >= 3:
                            say("  three refusals in a row — stopping fetches. "
                                "Re-export cookies rather than retrying.")
                            blocked.set()

    def poser() -> None:
        while True:
            item = pose_q.get()
            if item is None:
                return
            f, path = item
            vid = f.youtube_video_id
            if pose.skeleton_path(vid).exists():
                continue
            try:
                t0 = time.time()
                pose.extract(vid, path, progress=False)
                with lock:
                    stats["posed"] += 1
                say(f"[pose] {f.title[:44]} in {time.time()-t0:.0f}s "
                    f"({stats['posed']}/{len(todo)})")
                if not args.keep_video:
                    fetch.video_path(vid).unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                with lock:
                    stats["pose_failed"] += 1
                say(f"[pose] FAILED {vid}")
                traceback.print_exc(limit=2)

    workers = [threading.Thread(target=fetcher, args=(i,), daemon=True)
               for i in range(args.workers)]
    pose_thread = threading.Thread(target=poser, daemon=True)
    for w in workers:
        w.start()
    pose_thread.start()
    for w in workers:
        w.join()
    pose_q.put(None)
    pose_thread.join()

    print(f"\nfetched {stats['fetched']}  posed {stats['posed']}  "
          f"fetch failures {stats['fetch_failed']}  pose failures {stats['pose_failed']}")


if __name__ == "__main__":
    main()

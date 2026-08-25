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
from src.manifest import Fight, read_manifest  # noqa: E402

# The gate is a correlation, so the sample has to span the thing being
# correlated. Taking the most recent N would instead sample one era of
# broadcast camera work — a confound dressed up as convenience.
STRATA = ((0.00, 0.05), (0.05, 0.15), (0.15, 0.30), (0.30, 0.50), (0.50, 1.01))
SAMPLE_SEED = 7

# The pilot's size, so --holdout can reconstruct exactly which fights it
# drew and refuse to draw them again.
PILOT_SIZE = 40


def _sample(fights: list[Fight], limit: int,
            exclude: set[str] | None = None) -> list[Fight]:
    """Even draw across ground-share strata, deterministic."""
    import random

    if exclude:
        fights = [f for f in fights if f.youtube_video_id not in exclude]
    rng = random.Random(SAMPLE_SEED)
    buckets: list[list[Fight]] = []
    for lo, hi in STRATA:
        b = [f for f in fights if lo <= f.ground_strike_share < hi]
        rng.shuffle(b)
        buckets.append(b)

    picked: list[Fight] = []
    while len(picked) < limit and any(buckets):
        for b in buckets:
            if b and len(picked) < limit:
                picked.append(b.pop())
    picked.sort(key=lambda f: f.event_date)
    return picked


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="stop after N fights")
    ap.add_argument("--holdout", action="store_true",
                    help="draw from fights the pilot never touched — the only "
                         "honest way to score a rule tuned on the pilot")
    ap.add_argument("--stratify", action="store_true",
                    help="spread the sample across the ground-share range "
                         "instead of taking the most recent N")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--download-only", action="store_true",
                    help="fetch and normalise, skip pose (lets the network "
                         "work run while the torch install finishes)")
    ap.add_argument("--pose-only", action="store_true",
                    help="assume video is already cached; never hit the network")
    ap.add_argument("--keep-video", action="store_true",
                    help="keep the source download (default: delete after pose)")
    args = ap.parse_args()

    fights = read_manifest()
    if args.holdout:
        pilot = {f.youtube_video_id for f in _sample(fights, PILOT_SIZE)}
        fights = _sample(fights, args.limit or 10**9, exclude=pilot)
        print(f"holdout draw: {len(fights)} fights, none of them in the pilot {PILOT_SIZE}")
    elif args.limit:
        fights = _sample(fights, args.limit) if args.stratify else fights[: args.limit]

    # If YouTube starts refusing, stop asking. Grinding through forty
    # rejections is how a session gets flagged, and the rejections are
    # not independent — the first one already told us the answer.
    BLOCK_MARKERS = ("not a bot", "Sign in to confirm", "HTTP Error 429")
    MAX_CONSECUTIVE_BLOCKS = 3
    consecutive_blocks = 0

    done = failed = 0
    for i, f in enumerate(fights, 1):
        out = pose.skeleton_path(f.youtube_video_id)
        if args.download_only and fetch.normalised_path(f.youtube_video_id).exists() \
                and not args.overwrite:
            print(f"[{i}/{len(fights)}] cached  {f.title[:60]}")
            done += 1
            continue
        if out.exists() and not args.overwrite:
            print(f"[{i}/{len(fights)}] cached  {f.title[:60]}")
            done += 1
            continue

        print(f"[{i}/{len(fights)}] {f.title[:60]}")
        t0 = time.time()
        try:
            if args.pose_only:
                normalised = fetch.normalised_path(f.youtube_video_id)
                if not normalised.exists():
                    raise FileNotFoundError(f"{normalised.name} not cached")
            else:
                if not fetch.video_path(f.youtube_video_id).exists():
                    fetch.polite_pause()
                normalised = fetch.prepare(f.youtube_video_id)
            consecutive_blocks = 0
            if args.download_only:
                done += 1
                print(f"    fetched in {time.time() - t0:.0f}s")
                continue
            pose.extract(f.youtube_video_id, normalised, overwrite=args.overwrite)
            done += 1
            if not args.keep_video:
                fetch.video_path(f.youtube_video_id).unlink(missing_ok=True)
            print(f"    ok in {time.time() - t0:.0f}s -> {out.name}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"    FAILED: {exc}")
            message = str(exc)
            if any(m in message for m in BLOCK_MARKERS):
                consecutive_blocks += 1
                if consecutive_blocks >= MAX_CONSECUTIVE_BLOCKS:
                    print(f"\n  aborting: {consecutive_blocks} consecutive refusals from "
                          f"YouTube — the cookie jar is stale or the session is flagged. "
                          f"Re-export cookies rather than retrying.")
                    break
            else:
                consecutive_blocks = 0
                traceback.print_exc(limit=2)

    print(f"\ndone: {done}   failed: {failed}")


if __name__ == "__main__":
    main()

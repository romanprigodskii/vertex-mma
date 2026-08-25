"""Does identity survive at a higher sampling rate?

The decline detector needs to know WHICH skeleton is which fighter —
"his output fell across three fights" is meaningless without it. That
needs tracking, and tracking at 5 fps does not work: 200 ms between
samples is long enough for a fighter to move further than the tracker's
motion model expects, so identities churn. Measured on Lesnar vs Mir:
71 distinct ids across 301 frames, the best present in half of them.

This asks whether more frames fixes it, and prices the answer. Tripling
the rate triples a 400 h corpus run, so the question is worth an hour
before it is worth a rented GPU.

    python scripts/probe_tracking.py --video-id WD2-K7dsqYM --fps 5 15
"""

from __future__ import annotations

import argparse
import collections
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import fetch, pose  # noqa: E402

# 60 s of fight is enough to see identity hold or churn, and short
# enough that three rates fit in an hour.
WINDOW_SECONDS = 60


def resample(video_id: str, fps: int, out_dir: Path) -> Path:
    src = fetch.video_path(video_id)
    if not src.exists():
        src = fetch.normalised_path(video_id)      # fall back to the 5 fps copy
    out = out_dir / f"{video_id}_probe_{fps}fps.mp4"
    if out.exists():
        return out
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", "60", "-t", str(WINDOW_SECONDS),
         "-i", str(src), "-vf", f"fps={fps},scale=-2:720", "-an",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", str(out)],
        check=True,
    )
    return out


def probe(video_id: str, fps: int, out_dir: Path) -> dict:
    from ultralytics import YOLO

    clip = resample(video_id, fps, out_dir)
    model = YOLO(str(pose.MODEL_DIR / pose.MODEL_NAME))

    counts: collections.Counter = collections.Counter()
    frames = 0
    t0 = time.time()
    for r in model.track(str(clip), stream=True, persist=True, tracker="botsort.yaml",
                         verbose=False, conf=pose.MIN_DET_CONF, classes=[0], device="mps"):
        frames += 1
        if r.boxes is not None and r.boxes.id is not None:
            for t in r.boxes.id.cpu().numpy().astype(int):
                counts[t] += 1
    elapsed = time.time() - t0

    top2 = counts.most_common(2)
    # The number that decides it: if the two fighters really are two
    # tracks, the top two ids should each be present in most frames.
    persistence = sum(c for _, c in top2) / (2 * frames) if frames and top2 else 0.0
    return {
        "fps": fps,
        "frames": frames,
        "distinct_ids": len(counts),
        "top2_persistence": persistence,
        "ids_per_100_frames": 100.0 * len(counts) / frames if frames else 0.0,
        "seconds": elapsed,
        "throughput_fps": frames / elapsed if elapsed else 0.0,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video-id", default="WD2-K7dsqYM")
    ap.add_argument("--fps", type=int, nargs="+", default=[5, 10, 15])
    args = ap.parse_args()

    out_dir = pose.DATA / "probe"
    print(f"{'fps':>4} {'frames':>7} {'ids':>5} {'ids/100f':>9} {'top2 persist':>13} {'infer fps':>10}")
    results = []
    for fps in args.fps:
        r = probe(args.video_id, fps, out_dir)
        results.append(r)
        print(f"{r['fps']:>4} {r['frames']:>7} {r['distinct_ids']:>5} "
              f"{r['ids_per_100_frames']:>9.1f} {r['top2_persistence']:>12.0%} "
              f"{r['throughput_fps']:>10.1f}")

    best = max(results, key=lambda r: r["top2_persistence"])
    print()
    if best["top2_persistence"] >= 0.80:
        cost = best["fps"] / 5.0
        print(f"VIABLE at {best['fps']} fps — {best['top2_persistence']:.0%} persistence.")
        print(f"Costs {cost:.0f}x the corpus run: ~{400 * cost:.0f} h on this laptop.")
    else:
        print(f"NOT VIABLE — best persistence {best['top2_persistence']:.0%} at "
              f"{best['fps']} fps. Identity needs an appearance cue (shorts "
              f"colour, corner assignment), not more frames.")


if __name__ == "__main__":
    main()

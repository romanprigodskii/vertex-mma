"""Can tracklets be merged into two fighters? Measured on unseen frames.

    python scripts/probe_merge.py --limit 6

Runs tracking (not plain detection) over each fight, groups detections
into tracklets, and two-colours the "seen together" graph. The score is
the split rate on held-out frames the graph was never built from —
because two-colouring a graph and testing on its own edges is a
tautology, not a measurement.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import fetch, pose, tracklets  # noqa: E402
from src.manifest import read_manifest  # noqa: E402

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"
TRACKER_CFG = Path(__file__).resolve().parents[1] / "artifacts" / "botsort_reid.yaml"

# The four fights the merge method was tuned on, pinned by id rather than
# recomputed. The original selection was "whatever video happens to be
# cached", which on a fresh box silently resolves to a DIFFERENT four —
# and a holdout that quietly includes your training set is worse than no
# holdout at all, because it looks like evidence.
TUNED_ON = (
    "Kjq4Jz1XuiI",   # Salkilld vs Mullarkey      240 s
    "y6RxnkLDxqI",   # Dvalishvili vs Yan 1      1620 s
    "W6Row8U6OzQ",   # Daukaus vs Meerschaert     267 s
    "AfTsPnieFqQ",   # Saint Denis vs Dariush     333 s
)

# Long fights were where the method failed before the greedy pass, so
# duration is the axis the holdout has to span — sampling by recency
# would stack it with whatever the UFC uploaded lately.
DURATION_STRATA = ((0, 400), (400, 700), (700, 1200), (1200, 10_000))
HOLDOUT_SEED = 11


def signatures(video_path: Path, det: pd.DataFrame) -> dict:
    """One colour signature per tracklet, averaged over all its frames.

    This is the same descriptor that failed as a per-frame identity cue,
    and the difference is not the descriptor — it is that a tracklet
    offers tens to hundreds of frames to average, and is then asked for
    a single bit rather than a label per frame.

    The box's outer quarter is dropped on each side: at the edges it is
    canvas, cage and crowd, and averaging those in is how a signature
    becomes the arena's colour instead of the fighter's.
    """
    import cv2

    wanted = {}
    for _, r in det.iterrows():
        wanted.setdefault(int(r["frame_idx"]), []).append(r)

    acc: dict[int, list] = {}
    cap = cv2.VideoCapture(str(video_path))
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        rows = wanted.get(idx)
        if rows:
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
            H, W = hsv.shape[:2]
            for r in rows:
                x0, y0, x1, y1 = (float(r["x1"]), float(r["y1"]),
                                  float(r["x2"]), float(r["y2"]))
                dx, dy = (x1 - x0) * tracklets.BOX_INSET, (y1 - y0) * tracklets.BOX_INSET
                a = max(0, int(x0 + dx)); b = min(W, int(x1 - dx))
                c = max(0, int(y0 + dy)); d = min(H, int(y1 - dy))
                if b - a < 4 or d - c < 4:
                    continue
                patch = hsv[c:d, a:b].reshape(-1, 3)
                patch = patch[patch[:, 1] >= 60]           # colour, not grey
                if len(patch) < 30:
                    continue
                h = np.bincount(
                    (patch[:, 0].astype(int) * tracklets.APPEARANCE_BINS) // 180,
                    minlength=tracklets.APPEARANCE_BINS,
                ).astype(float)
                acc.setdefault(int(r["track_id"]), []).append(h / h.sum())
        idx += 1
    cap.release()

    out = {}
    for t, hs in acc.items():
        if len(hs) < tracklets.MIN_GROUP_FRAMES:
            continue
        v = np.mean(hs, axis=0)
        n = np.linalg.norm(v)
        if n > 1e-9:
            out[t] = v / n
    return out


def track_video(video_path: Path) -> pd.DataFrame:
    from ultralytics import YOLO

    model = YOLO(str(pose.MODEL_DIR / pose.MODEL_NAME))
    rows = []
    for i, r in enumerate(model.track(
        str(video_path), stream=True, persist=True,
        tracker=str(TRACKER_CFG) if TRACKER_CFG.exists() else "botsort.yaml",
        verbose=False, conf=pose.MIN_DET_CONF, classes=[0],
        device=pose.pick_device(),
    )):
        if r.boxes is None or r.boxes.id is None:
            continue
        b = r.boxes.xyxy.cpu().numpy()
        ids = r.boxes.id.cpu().numpy().astype(int)
        area = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
        for k, (t, a) in enumerate(zip(ids, area)):
            rows.append({"frame_idx": i, "track_id": int(t), "area": float(a),
                         "x1": float(b[k, 0]), "y1": float(b[k, 1]),
                         "x2": float(b[k, 2]), "y2": float(b[k, 3])})
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=6)
    ap.add_argument("--holdout", action="store_true",
                    help="stratified draw over duration from fights the merge "
                         "method has never been tuned on")
    ap.add_argument("--jobs", type=int, default=1,
                    help="fights processed at once. Tracking is CPU-decode "
                         "bound, so this is the knob that uses the machine — "
                         "one job leaves 127 of 128 cores idle.")
    ap.add_argument("--cached-only", action="store_true",
                    help="only fights whose video is already on disk")
    args = ap.parse_args()

    fights = list(read_manifest())
    if args.cached_only:
        fights = [f for f in fights
                  if fetch.normalised_path(f.youtube_video_id).exists()]

    if args.holdout:
        import random

        rng = random.Random(HOLDOUT_SEED)
        pool = [f for f in fights if f.youtube_video_id not in TUNED_ON]
        buckets = []
        for lo, hi in DURATION_STRATA:
            b = [f for f in pool if lo <= f.duration_seconds < hi]
            rng.shuffle(b)
            buckets.append(b)
        picked = []
        while len(picked) < (args.limit or len(pool)) and any(buckets):
            for b in buckets:
                if b and len(picked) < (args.limit or len(pool)):
                    picked.append(b.pop())
        fights = sorted(picked, key=lambda f: f.duration_seconds)
        print(f"holdout: {len(fights)} fights, none of them among the four "
              f"the method was tuned on")
        print(f"duration span: {fights[0].duration_seconds}s "
              f"- {fights[-1].duration_seconds}s\n")
    else:
        fights = fights[: args.limit]
        print(f"{len(fights)} fights\n")

    reports = []
    lock = threading.Lock()
    done = [0]

    def handle(f):
        vid = f.youtube_video_id
        try:
            if not fetch.normalised_path(vid).exists():
                fetch.prepare(vid)
            det = track_video(fetch.normalised_path(vid))
            if det.empty:
                return None
            sig = signatures(fetch.normalised_path(vid), det)
            rep, _ = tracklets.merge(vid, det, signatures=sig)
        except Exception as exc:  # noqa: BLE001
            with lock:
                done[0] += 1
                print(f"[{done[0]}/{len(fights)}] FAILED {str(exc)[:60]}  "
                      f"{f.title[:34]}", flush=True)
            return None
        with lock:
            done[0] += 1
            flag = "OK " if rep.usable else "no "
            print(f"[{done[0]}/{len(fights)}] {flag} split={rep.holdout_split:.2f} "
                  f"(n={rep.holdout_pairs:4d})  frustration={rep.frustration:.2f}  "
                  f"cand={rep.candidates:3d} comp={rep.components:2d}  "
                  f"{f.duration_seconds:5d}s  {f.title[:30]}", flush=True)
        return {**asdict(rep), "title": f.title[:40],
                "duration": f.duration_seconds}

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for r in pool.map(handle, fights):
            if r:
                reports.append(r)

    if not reports:
        return
    df = pd.DataFrame(reports)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    df.to_parquet(ARTIFACTS / "merge_probe.parquet", index=False)
    ok = int(df["usable"].sum())
    print()
    print(f"usable on {ok}/{len(df)} fights")
    print(f"median holdout split : {df['holdout_split'].median():.3f}  (0.50 = chance)")
    print(f"median frustration   : {df['frustration'].median():.3f}  (0 = perfectly bipartite)")
    (ARTIFACTS / "merge_probe.json").write_text(json.dumps({
        "fights": len(df), "usable": ok,
        "median_holdout_split": float(df["holdout_split"].median()),
        "median_frustration": float(df["frustration"].median()),
        "threshold": 0.80,
    }, indent=2))


if __name__ == "__main__":
    main()

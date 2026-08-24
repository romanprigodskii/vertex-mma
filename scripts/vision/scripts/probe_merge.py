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
from dataclasses import asdict
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import fetch, pose, tracklets  # noqa: E402
from src.manifest import read_manifest  # noqa: E402

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"
TRACKER_CFG = Path(__file__).resolve().parents[1] / "artifacts" / "botsort_reid.yaml"


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
        for t, a in zip(ids, area):
            rows.append({"frame_idx": i, "track_id": int(t), "area": float(a)})
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=6)
    args = ap.parse_args()

    fights = [f for f in read_manifest()
              if fetch.normalised_path(f.youtube_video_id).exists()][: args.limit]
    print(f"{len(fights)} fights with cached video\n")

    reports = []
    for i, f in enumerate(fights, 1):
        vid = f.youtube_video_id
        det = track_video(fetch.normalised_path(vid))
        if det.empty:
            print(f"[{i}/{len(fights)}] no detections  {f.title[:40]}")
            continue
        rep, _ = tracklets.merge(vid, det)
        reports.append({**asdict(rep), "title": f.title[:40]})
        flag = "OK " if rep.usable else "no "
        print(f"[{i}/{len(fights)}] {flag} holdout split={rep.holdout_split:.2f} "
              f"(n={rep.holdout_pairs:4d})  frustration={rep.frustration:.2f}  "
              f"tracklets={rep.tracklets:3d}->{rep.candidates:2d}  comp={rep.components}  "
              f"{f.title[:34]}")

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

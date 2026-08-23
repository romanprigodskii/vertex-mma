"""Skeleton extraction — the expensive, irreversible step.

Design rule: this module decides as little as possible. It runs the pose
model and writes what it saw, including people who are plainly not
fighters (the referee, a cornerman leaning over the fence, the crowd).
Selecting *which* skeletons are the two fighters is a heuristic, and
heuristics get revised; re-running an hour of GPU time because the
selection rule changed would be self-inflicted. So selection lives in
features.py, over this file's output.

Keypoints are COCO-17, in pixels, alongside the frame size so downstream
code can normalise however it likes.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).resolve().parents[1] / "data"
SKELETON_DIR = DATA / "skeletons"

# yolo11m-pose: the accuracy/throughput knee on an M3. The x variant is
# ~2.5x slower for a few points of AP that occlusion will eat anyway.
MODEL_NAME = "yolo11m-pose.pt"

# Keep more people than there are fighters. Two is the answer we expect;
# storing four means a frame where the referee outranks a grounded
# fighter on bbox area is recoverable rather than lost.
MAX_PERSONS_PER_FRAME = 4

# Below this the box is a guess, and a guessed skeleton is worse than a
# missing one — it pollutes the geometry with a plausible-looking body.
MIN_DET_CONF = 0.35

BATCH_FRAMES = 16

COCO_KEYPOINTS = (
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
)


def skeleton_path(video_id: str) -> Path:
    return SKELETON_DIR / f"{video_id}.parquet"


def _load_model():
    from ultralytics import YOLO

    import torch

    model = YOLO(MODEL_NAME)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    return model, device


def extract(video_id: str, video_file: Path, *, overwrite: bool = False,
            progress: bool = True) -> Path:
    """Run pose over every frame of `video_file`, write one parquet."""
    out = skeleton_path(video_id)
    if out.exists() and not overwrite:
        return out

    import cv2

    model, device = _load_model()
    cap = cv2.VideoCapture(str(video_file))
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {video_file}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 5.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    records: list[dict] = []
    batch: list[np.ndarray] = []
    batch_idx: list[int] = []
    frame_idx = 0

    def flush() -> None:
        if not batch:
            return
        results = model.predict(
            batch, device=device, verbose=False, conf=MIN_DET_CONF, classes=[0]
        )
        for fi, res in zip(batch_idx, results):
            if res.keypoints is None or res.boxes is None or len(res.boxes) == 0:
                continue
            boxes = res.boxes.xyxy.cpu().numpy()
            confs = res.boxes.conf.cpu().numpy()
            kxy = res.keypoints.xy.cpu().numpy()          # (n, 17, 2)
            kconf = res.keypoints.conf
            kconf = (
                kconf.cpu().numpy()
                if kconf is not None
                else np.ones(kxy.shape[:2], dtype=np.float32)
            )
            areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
            order = np.argsort(-areas)[:MAX_PERSONS_PER_FRAME]
            for rank, pi in enumerate(order):
                records.append(
                    {
                        "frame_idx": fi,
                        "t_sec": fi / fps,
                        "person_rank": rank,          # 0 = largest box in frame
                        "det_conf": float(confs[pi]),
                        "x1": float(boxes[pi, 0]), "y1": float(boxes[pi, 1]),
                        "x2": float(boxes[pi, 2]), "y2": float(boxes[pi, 3]),
                        "kx": kxy[pi, :, 0].astype("float32").tolist(),
                        "ky": kxy[pi, :, 1].astype("float32").tolist(),
                        "kc": kconf[pi].astype("float32").tolist(),
                    }
                )
        batch.clear()
        batch_idx.clear()

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        batch.append(frame)
        batch_idx.append(frame_idx)
        if len(batch) >= BATCH_FRAMES:
            flush()
            if progress and frame_idx % (BATCH_FRAMES * 20) == 0:
                pct = 100.0 * frame_idx / total if total else 0.0
                print(f"    {video_id}  {frame_idx}/{total} frames ({pct:.0f}%)", flush=True)
        frame_idx += 1
    flush()
    cap.release()

    df = pd.DataFrame.from_records(records)
    SKELETON_DIR.mkdir(parents=True, exist_ok=True)
    df.attrs.update({"video_id": video_id, "fps": fps, "width": width, "height": height})
    # attrs do not survive parquet; carry them as columns instead.
    if df.empty:
        df = pd.DataFrame(
            columns=["frame_idx", "t_sec", "person_rank", "det_conf",
                     "x1", "y1", "x2", "y2", "kx", "ky", "kc"]
        )
    df["frame_width"] = width
    df["frame_height"] = height
    df["source_fps"] = fps
    df["n_frames"] = frame_idx
    df.to_parquet(out, index=False)
    return out

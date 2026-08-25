"""Draw what the pipeline sees onto the footage it saw it in.

Deliberately reuses features._geometry_frame and the same constants, so
this is not a second implementation that could flatter the first. If the
overlay says CLINCH, the feature vector said clinch on that frame.

    python scripts/render_overlay.py --video-id WD2-K7dsqYM --out ~/Downloads

Colour: the two bodies the pipeline actually measures are cyan and
orange. Everyone else it detected — referee, cornermen, front row — is
drawn dim grey, because "who got picked" is the pipeline's main failure
mode and hiding it would make the demo a lie.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import features, fetch, pose  # noqa: E402
from src.manifest import read_manifest  # noqa: E402

EDGES = (
    (5, 7), (7, 9), (6, 8), (8, 10),            # arms
    (5, 6), (5, 11), (6, 12), (11, 12),         # torso
    (11, 13), (13, 15), (12, 14), (14, 16),     # legs
    (0, 1), (0, 2), (1, 3), (2, 4),             # face
)

FIGHTER_COLOURS = ((255, 220, 40), (40, 150, 255))   # BGR: cyan, orange
OTHER_COLOUR = (110, 110, 110)
STATE_COLOURS = {
    "GROUND": (80, 80, 255),
    "CLINCH": (60, 200, 255),
    "DISTANCE": (120, 240, 120),
}
OUTPUT_FPS = 15          # each 5 fps sample held 3x — real time, plays anywhere


def draw_person(img, kx, ky, kc, colour, thickness=2):
    for a, b in EDGES:
        if kc[a] < features.MIN_KP_CONF or kc[b] < features.MIN_KP_CONF:
            continue
        cv2.line(img, (int(kx[a]), int(ky[a])), (int(kx[b]), int(ky[b])),
                 colour, thickness, cv2.LINE_AA)
    for i in range(17):
        if kc[i] >= features.MIN_KP_CONF:
            cv2.circle(img, (int(kx[i]), int(ky[i])), thickness + 1, colour, -1, cv2.LINE_AA)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video-id", required=True)
    ap.add_argument("--out", type=Path, default=Path.home() / "Downloads")
    ap.add_argument("--start", type=float, default=0.0, help="seconds")
    ap.add_argument("--duration", type=float, default=None, help="seconds")
    args = ap.parse_args()

    src = fetch.normalised_path(args.video_id)
    if not src.exists():
        raise SystemExit(f"{src} missing — normalised video was deleted?")
    sk = pd.read_parquet(pose.skeleton_path(args.video_id))
    geo = features._geometry_frame(sk)

    title = next(
        (f.title for f in read_manifest() if f.youtube_video_id == args.video_id),
        args.video_id,
    )

    by_frame = {int(k): v for k, v in sk.groupby("frame_idx")}
    pair = geo[geo["person_rank"] <= 1].set_index(["frame_idx", "person_rank"])

    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS) or 5.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    args.out.mkdir(parents=True, exist_ok=True)
    dest = args.out / f"vertex_pose_{args.video_id}.mp4"
    writer = cv2.VideoWriter(str(dest), cv2.VideoWriter_fourcc(*"avc1"), OUTPUT_FPS, (w, h))
    if not writer.isOpened():
        writer = cv2.VideoWriter(str(dest), cv2.VideoWriter_fourcc(*"mp4v"), OUTPUT_FPS, (w, h))

    first = int(args.start * fps)
    last = int((args.start + args.duration) * fps) if args.duration else 10**9
    tally = {"GROUND": 0, "CLINCH": 0, "DISTANCE": 0}
    idx = written = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx < first:
            idx += 1
            continue
        if idx > last:
            break

        rows = by_frame.get(idx)
        state, sep = None, None
        if rows is not None:
            ranked = rows.sort_values("person_rank")
            for _, r in ranked.iterrows():
                rank = int(r["person_rank"])
                colour = FIGHTER_COLOURS[rank] if rank <= 1 else OTHER_COLOUR
                draw_person(frame, np.asarray(r["kx"]), np.asarray(r["ky"]),
                            np.asarray(r["kc"]), colour, 2 if rank <= 1 else 1)

            try:
                a = pair.loc[(idx, 0)]
                b = pair.loc[(idx, 1)]
                scale = (a["torso"] + b["torso"]) / 2.0
                if scale >= 1e-3:
                    sep = float(np.hypot(a["cx"] - b["cx"], a["cy"] - b["cy"]) / scale)
                    a_gr = (a["aspect"] < features.GROUND_ASPECT) or (a["tilt"] > features.GROUND_TILT_DEGREES)
                    b_gr = (b["aspect"] < features.GROUND_ASPECT) or (b["tilt"] > features.GROUND_TILT_DEGREES)
                    if a_gr and b_gr and sep < features.CLINCH_SEPARATION * 1.5:
                        state = "GROUND"
                    elif sep < features.CLINCH_SEPARATION:
                        state = "CLINCH"
                    else:
                        state = "DISTANCE"
                    tally[state] += 1
            except KeyError:
                pass

        cv2.rectangle(frame, (0, 0), (w, 78), (18, 18, 18), -1)
        cv2.putText(frame, title[:58], (14, 26), cv2.FONT_HERSHEY_SIMPLEX,
                    0.62, (235, 235, 235), 1, cv2.LINE_AA)
        stamp = f"{int(idx / fps) // 60:d}:{int(idx / fps) % 60:02d}"
        label = state or "no pair"
        cv2.putText(frame, f"{stamp}   {label}", (14, 60), cv2.FONT_HERSHEY_SIMPLEX,
                    0.78, STATE_COLOURS.get(label, (150, 150, 150)), 2, cv2.LINE_AA)
        if sep is not None:
            cv2.putText(frame, f"separation {sep:.2f} torsos", (300, 60),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.58, (200, 200, 200), 1, cv2.LINE_AA)
        done = sum(tally.values()) or 1
        cv2.putText(frame, f"ground {100*tally['GROUND']//done}%  "
                           f"clinch {100*tally['CLINCH']//done}%  "
                           f"distance {100*tally['DISTANCE']//done}%",
                    (w - 430, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (200, 200, 200), 1, cv2.LINE_AA)

        for _ in range(3):          # hold each 5 fps sample -> real-time at 15 fps
            writer.write(frame)
        written += 1
        idx += 1

    cap.release()
    writer.release()
    print(f"{written} frames -> {dest}")
    print(f"running tally: {tally}")


if __name__ == "__main__":
    main()

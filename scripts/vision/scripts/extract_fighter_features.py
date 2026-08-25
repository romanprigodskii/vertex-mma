"""One row per fighter per fight — the thing identity was blocking.

Everything before this produced bout-level numbers: how much of a fight
happened on the ground, not who was underneath. A decline detector needs
the second kind, and could not have them until tracklet merging worked.

Per fighter, per fight:
  grounded_share  how often his body reads as flat — being underneath
  movement        hip displacement per second in TORSO LENGTHS, so a
                  zoom does not read as footwork
  coverage        frames he was resolvable in, so thin fights can be
                  dropped rather than quietly averaged in

Movement is the candidate decline signal. An aging fighter moves less,
and unlike strike counts it needs no technique recognition — which
matters, because at 5 fps individual strikes are invisible anyway.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import attribute, fetch, tracklets  # noqa: E402

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"

# Below this a fighter was resolvable too rarely for his numbers to mean
# anything, and averaging him in is how a thin fight becomes a data point.
MIN_COVERAGE = 0.35


def _probe_merge():
    spec = importlib.util.spec_from_file_location(
        "pm", Path(__file__).resolve().parent / "probe_merge.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["pm"] = mod
    spec.loader.exec_module(mod)
    return mod


def per_track_stats(det: pd.DataFrame) -> pd.DataFrame:
    """Grounded share and normalised movement, per track."""
    det = det.sort_values(["track_id", "frame_idx"]).copy()
    det["cx"] = (det["x1"] + det["x2"]) / 2.0
    det["cy"] = (det["y1"] + det["y2"]) / 2.0
    det["h"] = det["y2"] - det["y1"]
    det["w"] = det["x2"] - det["x1"]
    # Same scale the feature pass uses: the body's longest side, which a
    # grounded fighter keeps and a bounding box height does not.
    det["scale"] = np.maximum(det["h"], det["w"]).clip(lower=1.0)
    det["grounded"] = (det["h"] / det["w"].clip(lower=1.0)) < 1.45

    rows = []
    for tid, g in det.groupby("track_id"):
        dx = g["cx"].diff()
        dy = g["cy"].diff()
        dt = g["frame_idx"].diff()
        step = np.hypot(dx, dy) / g["scale"]
        # Only consecutive samples; a gap means the track was lost and
        # the apparent jump is bookkeeping, not footwork.
        step = step[dt == 1]
        rows.append({
            "track_id": int(tid),
            "frames": len(g),
            "grounded": float(g["grounded"].mean()),
            "movement": float(step.median()) if len(step) else float("nan"),
        })
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    pm = _probe_merge()
    anchor = json.loads((ARTIFACTS / "anchor.json").read_text())["bouts"]
    anchor = [a for a in anchor if a["video_id"]
              and a["control_a"] + a["control_b"] > 0]
    if args.limit:
        anchor = anchor[: args.limit]
    print(f"{len(anchor)} bouts with video and an anchor\n")

    out, lock, done = [], threading.Lock(), [0]

    def handle(a):
        vid = a["video_id"]
        try:
            if not fetch.normalised_path(vid).exists():
                fetch.prepare(vid)
            det = pm.track_video(fetch.normalised_path(vid))
            if det.empty:
                raise ValueError("no detections")
            rep, labels = tracklets.merge(vid, det)
            stats = per_track_stats(det)
            stats = stats[stats["track_id"].isin(labels)]
            att = attribute.attribute(a["bout_id"], labels, stats,
                                      a["control_a"], a["control_b"])
        except Exception as exc:  # noqa: BLE001
            with lock:
                done[0] += 1
                print(f"[{done[0]}/{len(anchor)}] FAILED {str(exc)[:50]}  "
                      f"{a['name_a']} vs {a['name_b']}", flush=True)
            return []

        rows = []
        if att.group_for_a is not None:
            for side, gid in (("a", att.group_for_a), ("b", 1 - att.group_for_a)):
                tracks = [t for t, lab in labels.items() if lab == gid]
                s = stats[stats["track_id"].isin(tracks)]
                if s.empty:
                    continue
                weights = s["frames"].to_numpy(dtype=float)
                rows.append({
                    "bout_id": a["bout_id"], "date": a["date"],
                    "fighter_id": a[f"fighter_{side}"],
                    "name": a[f"name_{side}"],
                    "side": side,
                    "won": (a["a_won"] if side == "a"
                            else (None if a["a_won"] is None else not a["a_won"])),
                    "grounded": float(np.average(s["grounded"], weights=weights)),
                    "movement": float(np.average(
                        s["movement"].fillna(s["movement"].median()),
                        weights=weights)),
                    "frames": int(s["frames"].sum()),
                    "attribution_margin": att.margin,
                    "attribution_confident": att.confident,
                    "merge_split": rep.holdout_split,
                })
        with lock:
            done[0] += 1
            print(f"[{done[0]}/{len(anchor)}] margin={att.margin:.2f} "
                  f"{'OK ' if att.confident else 'weak'}  "
                  f"{a['name_a'][:18]} vs {a['name_b'][:18]}", flush=True)
        return rows

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for rows in pool.map(handle, anchor):
            out.extend(rows)

    df = pd.DataFrame(out)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    df.to_parquet(ARTIFACTS / "fighter_features.parquet", index=False)
    print(f"\nrows: {len(df)}   fighters: {df['fighter_id'].nunique() if len(df) else 0}")
    if len(df):
        conf = df[df["attribution_confident"]]
        print(f"confident attribution: {len(conf)}/{len(df)}")
    print(f"written: {ARTIFACTS / 'fighter_features.parquet'}")


if __name__ == "__main__":
    main()

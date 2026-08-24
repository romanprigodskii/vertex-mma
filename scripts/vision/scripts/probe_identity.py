"""Can shorts colour tell the two fighters apart? Measured, per fight.

    python scripts/probe_identity.py --limit 12

The metric needs no labels. In a frame holding both fighters, a
meaningful colour split puts them in DIFFERENT groups; chance puts them
in different groups half the time. So the fraction of two-body frames
where the pair splits IS the accuracy, read off directly.

The threshold is fixed here before any fight is scored, for the same
reason the pose gate's was: 0.80 usable, 0.50 is a coin.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import fetch, identity, pose  # noqa: E402
from src.manifest import read_manifest  # noqa: E402

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    fights = [
        f for f in read_manifest()
        if pose.skeleton_path(f.youtube_video_id).exists()
        and fetch.normalised_path(f.youtube_video_id).exists()
    ]
    if args.limit:
        fights = fights[: args.limit]
    print(f"{len(fights)} fights have both skeletons and video\n")

    reports = []
    for i, f in enumerate(fights, 1):
        vid = f.youtube_video_id
        sk = pd.read_parquet(pose.skeleton_path(vid))
        colours = identity.sample_colours(fetch.normalised_path(vid), sk)
        rep = identity.analyse(vid, colours)
        reports.append({**asdict(rep), "title": f.title[:44]})
        flag = "OK " if rep.usable else "no "
        print(f"[{i}/{len(fights)}] {flag} split={rep.disagreement:.2f} "
              f"contrast={rep.contrast:5.2f} patches={rep.patches:5d}  {f.title[:42]}")

    df = pd.DataFrame(reports)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    df.to_parquet(ARTIFACTS / "identity_probe.parquet", index=False)

    ok = df["usable"].sum()
    print()
    print(f"usable on {ok}/{len(df)} fights ({100*ok/len(df):.0f}%)")
    print(f"median split rate : {df['disagreement'].median():.3f}  (0.50 = chance)")
    print(f"median contrast   : {df['contrast'].median():.2f}")
    summary = {
        "fights": len(df),
        "usable": int(ok),
        "usable_fraction": float(ok / len(df)),
        "median_split": float(df["disagreement"].median()),
        "median_contrast": float(df["contrast"].median()),
        "threshold": 0.80,
    }
    (ARTIFACTS / "identity_probe.json").write_text(json.dumps(summary, indent=2))
    print(f"written: {ARTIFACTS / 'identity_probe.json'}")


if __name__ == "__main__":
    main()

"""Skeletons -> features -> the gate."""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import features, pose, validate  # noqa: E402
from src.manifest import read_manifest  # noqa: E402


def main() -> None:
    fights = read_manifest()
    by_video = {f.youtube_video_id: f for f in fights}

    rows = []
    for vid, fight in by_video.items():
        path = pose.skeleton_path(vid)
        if not path.exists():
            continue
        skeletons = pd.read_parquet(path)
        feat = features.compute(vid, skeletons)
        rows.append(
            {
                **asdict(feat),
                "bout_id": fight.bout_id,
                "title": fight.title,
                "event_date": fight.event_date,
                "ground_strike_share": fight.ground_strike_share,
                "distance_strike_share": fight.distance_strike_share,
                "control_share": fight.control_share,
                "takedowns": fight.takedowns,
            }
        )

    if not rows:
        print("no skeletons found — run extract_pose.py first")
        return

    df = pd.DataFrame(rows)
    out_dir = Path(__file__).resolve().parents[1] / "artifacts"
    out_dir.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out_dir / "pose_features.parquet", index=False)

    path = validate.write_report(df)
    report = json.loads(path.read_text())

    print(f"fights with skeletons : {len(df)}")
    print(f"verdict               : {report['verdict'].upper()}")
    if "primary" in report:
        p = report["primary"]
        print(f"primary  {p['name']}")
        print(f"         rho={p['rho']:+.3f}  p={p['p_value']:.4f}  n={p['n']}  -> {p['verdict']}")
        for s in report["secondary"]:
            print(f"  also   {s['name']}: rho={s['rho']:+.3f} p={s['p_value']:.4f} -> {s['verdict']}")
        print(f"coverage median       : {report['median_coverage']:.2f}")
        print(f"ambiguity median      : {report['median_ambiguity_rate']:.2f}")
    else:
        print(f"reason                : {report['reason']}")
    print(f"written               : {path}")


if __name__ == "__main__":
    main()

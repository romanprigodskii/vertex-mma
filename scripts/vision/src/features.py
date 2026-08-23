"""Skeletons -> bout-level geometry. No fighter identity anywhere.

Everything here describes the *pair*: how far apart the two bodies are,
how upright they are, how that changes. This is on purpose. Identity
(which skeleton is fighter A) is the hard sub-problem and it is not on
the critical path for the gate — "how much of this fight was on the
ground" needs no names.

Scale is the other trap. A broadcast zooms, so pixels mean nothing
across frames. Every distance below is expressed in torso lengths,
measured on the same frame it is used in.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# COCO-17 indices we lean on.
L_SHOULDER, R_SHOULDER = 5, 6
L_HIP, R_HIP = 11, 12

# A keypoint below this is the model guessing at an occluded joint.
MIN_KP_CONF = 0.30

# Torso lengths. Two bodies whose hips are within this are entangled —
# clinch or ground; beyond it they are striking at range or disengaged.
CLINCH_SEPARATION = 2.0

# A standing person's box is much taller than wide. A grounded one is
# not. This discriminates without trusting occluded keypoints, which is
# exactly the regime the ground game lives in.
GROUND_ASPECT = 1.45

# Torso tilted this far off vertical is not a stance.
GROUND_TILT_DEGREES = 45.0

# A frame needs two plausible bodies to say anything about configuration.
# Crowd shots, graphics and single-fighter replays fail this and are
# excluded rather than guessed at.
MIN_BODIES = 2


@dataclass(frozen=True)
class PoseFeatures:
    video_id: str
    frames_total: int
    frames_scored: int          # had two usable bodies
    coverage: float             # frames_scored / frames_total
    ambiguity_rate: float       # how often a 3rd body rivalled the 2nd
    frac_ground: float
    frac_clinch: float
    frac_distance: float
    mean_separation: float
    p90_separation: float
    separation_volatility: float
    mean_tilt: float


def _midpoint(kx: np.ndarray, ky: np.ndarray, kc: np.ndarray,
              a: int, b: int) -> tuple[float, float, bool]:
    """Midpoint of two keypoints; ok=False if either is a guess."""
    if kc[a] < MIN_KP_CONF or kc[b] < MIN_KP_CONF:
        return 0.0, 0.0, False
    return (kx[a] + kx[b]) / 2.0, (ky[a] + ky[b]) / 2.0, True


def _body_geometry(row) -> dict | None:
    """Torso vector, centroid and box aspect for one detected person."""
    kx = np.asarray(row["kx"], dtype=float)
    ky = np.asarray(row["ky"], dtype=float)
    kc = np.asarray(row["kc"], dtype=float)

    sx, sy, s_ok = _midpoint(kx, ky, kc, L_SHOULDER, R_SHOULDER)
    hx, hy, h_ok = _midpoint(kx, ky, kc, L_HIP, R_HIP)

    w = max(1e-6, row["x2"] - row["x1"])
    h = max(1e-6, row["y2"] - row["y1"])
    aspect = h / w

    if s_ok and h_ok:
        dx, dy = sx - hx, sy - hy
        torso = float(np.hypot(dx, dy))
        if torso < 1e-3:
            return None
        # Angle away from vertical; the image y axis points down, so an
        # upright torso has the shoulders *above* the hips (dy < 0).
        tilt = float(np.degrees(np.arctan2(abs(dx), abs(dy))))
        return {"cx": hx, "cy": hy, "torso": torso, "tilt": tilt, "aspect": aspect}

    # Keypoints occluded — fall back to the box, which still carries the
    # standing/grounded distinction even when joints are unrecoverable.
    #
    # Scale off the box's LONGEST side, not its height. A fighter lying
    # down has a short, wide box: height/3 would under-read his torso by
    # a factor of two or more, inflating every separation measured
    # against it and filing the ground exchange under "distance" — a bug
    # that would corrupt precisely the case this pipeline exists to test.
    return {
        "cx": (row["x1"] + row["x2"]) / 2.0,
        "cy": (row["y1"] + row["y2"]) / 2.0,
        "torso": max(h, w) / 3.0,   # a torso is roughly a third of a body's length
        "tilt": float("nan"),
        "aspect": aspect,
    }


def _is_grounded(body: dict) -> bool:
    if body["aspect"] < GROUND_ASPECT:
        return True
    tilt = body["tilt"]
    return not np.isnan(tilt) and tilt > GROUND_TILT_DEGREES


def compute(video_id: str, skeletons: pd.DataFrame) -> PoseFeatures:
    if skeletons.empty:
        return PoseFeatures(video_id, 0, 0, 0.0, 0.0, *([float("nan")] * 7))

    n_frames = int(skeletons["n_frames"].iloc[0])

    separations: list[float] = []
    states: list[str] = []
    tilts: list[float] = []
    ambiguous = 0

    for _, frame in skeletons.groupby("frame_idx", sort=True):
        frame = frame.sort_values("person_rank")
        bodies = [b for b in (_body_geometry(r) for _, r in frame.iterrows()) if b]
        if len(bodies) < MIN_BODIES:
            continue

        areas = [
            (r["x2"] - r["x1"]) * (r["y2"] - r["y1"])
            for _, r in frame.iterrows()
        ]
        # The referee is in nearly every frame and is sometimes bigger
        # than a fighter folded up on the mat. Track how often the third
        # body rivals the second — that is this pipeline's contamination
        # proxy, and the first suspect if the gate correlates weakly.
        if len(areas) >= 3 and areas[1] > 0 and areas[2] / areas[1] > 0.8:
            ambiguous += 1

        a, b = bodies[0], bodies[1]
        scale = (a["torso"] + b["torso"]) / 2.0
        if scale < 1e-3:
            continue
        sep = float(np.hypot(a["cx"] - b["cx"], a["cy"] - b["cy"])) / scale
        separations.append(sep)

        pair_tilts = [t for t in (a["tilt"], b["tilt"]) if not np.isnan(t)]
        if pair_tilts:
            tilts.append(float(np.mean(pair_tilts)))

        grounded = _is_grounded(a) and _is_grounded(b)
        if grounded and sep < CLINCH_SEPARATION * 1.5:
            states.append("ground")
        elif sep < CLINCH_SEPARATION:
            states.append("clinch")
        else:
            states.append("distance")

    scored = len(states)
    if scored == 0:
        return PoseFeatures(video_id, n_frames, 0, 0.0, 0.0, *([float("nan")] * 7))

    sep_arr = np.asarray(separations)
    counts = pd.Series(states).value_counts(normalize=True)

    return PoseFeatures(
        video_id=video_id,
        frames_total=n_frames,
        frames_scored=scored,
        coverage=scored / n_frames if n_frames else 0.0,
        ambiguity_rate=ambiguous / scored,
        frac_ground=float(counts.get("ground", 0.0)),
        frac_clinch=float(counts.get("clinch", 0.0)),
        frac_distance=float(counts.get("distance", 0.0)),
        mean_separation=float(sep_arr.mean()),
        p90_separation=float(np.percentile(sep_arr, 90)),
        separation_volatility=float(np.diff(sep_arr).std()) if len(sep_arr) > 1 else 0.0,
        mean_tilt=float(np.mean(tilts)) if tilts else float("nan"),
    )

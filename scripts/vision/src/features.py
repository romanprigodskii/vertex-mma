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

import warnings
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


def _geometry_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Vectorised _body_geometry over every detected person at once.

    The per-frame Python loop this replaces cost minutes per fight, which
    is survivable for a 40-fight pilot and not survivable for 7 582. Same
    arithmetic, same constants — just done in numpy rather than one
    `iterrows` call per body.
    """
    kx = np.stack(df["kx"].to_numpy())          # (n, 17)
    ky = np.stack(df["ky"].to_numpy())
    kc = np.stack(df["kc"].to_numpy())

    x1 = df["x1"].to_numpy(float); x2 = df["x2"].to_numpy(float)
    y1 = df["y1"].to_numpy(float); y2 = df["y2"].to_numpy(float)
    w = np.maximum(1e-6, x2 - x1)
    h = np.maximum(1e-6, y2 - y1)
    aspect = h / w

    shoulders_ok = (kc[:, L_SHOULDER] >= MIN_KP_CONF) & (kc[:, R_SHOULDER] >= MIN_KP_CONF)
    hips_ok = (kc[:, L_HIP] >= MIN_KP_CONF) & (kc[:, R_HIP] >= MIN_KP_CONF)
    ok = shoulders_ok & hips_ok

    sx = (kx[:, L_SHOULDER] + kx[:, R_SHOULDER]) / 2.0
    sy = (ky[:, L_SHOULDER] + ky[:, R_SHOULDER]) / 2.0
    hx = (kx[:, L_HIP] + kx[:, R_HIP]) / 2.0
    hy = (ky[:, L_HIP] + ky[:, R_HIP]) / 2.0

    dx, dy = sx - hx, sy - hy
    torso_kp = np.hypot(dx, dy)
    ok = ok & (torso_kp >= 1e-3)

    tilt = np.where(ok, np.degrees(np.arctan2(np.abs(dx), np.abs(dy))), np.nan)
    # Box fallback scales off the LONGEST side: a fighter lying down has a
    # short, wide box, and height/3 would halve his torso and inflate
    # every separation measured against it.
    cx = np.where(ok, hx, (x1 + x2) / 2.0)
    cy = np.where(ok, hy, (y1 + y2) / 2.0)
    torso = np.where(ok, torso_kp, np.maximum(h, w) / 3.0)

    return pd.DataFrame(
        {
            "frame_idx": df["frame_idx"].to_numpy(),
            "person_rank": df["person_rank"].to_numpy(),
            "cx": cx, "cy": cy, "torso": torso, "tilt": tilt,
            "aspect": aspect, "area": w * h,
        }
    )


def compute(video_id: str, skeletons: pd.DataFrame) -> PoseFeatures:
    if skeletons.empty:
        return PoseFeatures(video_id, 0, 0, 0.0, 0.0, *([float("nan")] * 7))

    n_frames = int(skeletons["n_frames"].iloc[0])
    geo = _geometry_frame(skeletons)

    # person_rank is the area ordering assigned at extraction, so rank 0
    # and rank 1 are the two biggest bodies in the frame.
    pair = geo[geo["person_rank"] <= 1]
    counts = pair.groupby("frame_idx")["person_rank"].size()
    usable_frames = counts[counts >= MIN_BODIES].index
    pair = pair[pair["frame_idx"].isin(usable_frames)].sort_values(
        ["frame_idx", "person_rank"]
    )
    if pair.empty:
        return PoseFeatures(video_id, n_frames, 0, 0.0, 0.0, *([float("nan")] * 7))

    a = pair[pair["person_rank"] == 0].set_index("frame_idx")
    b = pair[pair["person_rank"] == 1].set_index("frame_idx")
    common = a.index.intersection(b.index)
    a, b = a.loc[common], b.loc[common]

    scale = (a["torso"].to_numpy() + b["torso"].to_numpy()) / 2.0
    keep = scale >= 1e-3
    a, b, scale = a[keep], b[keep], scale[keep]
    if len(scale) == 0:
        return PoseFeatures(video_id, n_frames, 0, 0.0, 0.0, *([float("nan")] * 7))

    sep = np.hypot(
        a["cx"].to_numpy() - b["cx"].to_numpy(),
        a["cy"].to_numpy() - b["cy"].to_numpy(),
    ) / scale

    grounded = (
        ((a["aspect"].to_numpy() < GROUND_ASPECT) | (a["tilt"].to_numpy() > GROUND_TILT_DEGREES))
        & ((b["aspect"].to_numpy() < GROUND_ASPECT) | (b["tilt"].to_numpy() > GROUND_TILT_DEGREES))
    )
    is_ground = grounded & (sep < CLINCH_SEPARATION * 1.5)
    is_clinch = ~is_ground & (sep < CLINCH_SEPARATION)
    is_distance = ~is_ground & ~is_clinch

    scored = len(sep)

    # The referee is in nearly every frame and is sometimes bigger than a
    # fighter folded up on the mat. How often the third body rivals the
    # second is this pipeline's contamination proxy — the first suspect
    # if the gate correlates weakly.
    top3 = geo[geo["person_rank"] <= 2]
    areas = top3.pivot_table(index="frame_idx", columns="person_rank",
                             values="area", aggfunc="first")
    ambiguous = 0
    if {1, 2}.issubset(areas.columns):
        rival = areas.reindex(a.index)
        with np.errstate(invalid="ignore", divide="ignore"):
            ratio = rival[2].to_numpy() / rival[1].to_numpy()
        ambiguous = int(np.nansum(ratio > 0.8))

    # Frames where neither body gave a confident torso are all-NaN, and
    # nanmean is entitled to complain about them. They are expected —
    # that is the occlusion this pipeline is measuring — so silence the
    # warning rather than the data.
    stacked = np.vstack([a["tilt"].to_numpy(), b["tilt"].to_numpy()])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        tilts = np.nanmean(stacked, axis=0)

    return PoseFeatures(
        video_id=video_id,
        frames_total=n_frames,
        frames_scored=scored,
        coverage=scored / n_frames if n_frames else 0.0,
        ambiguity_rate=ambiguous / scored,
        frac_ground=float(is_ground.mean()),
        frac_clinch=float(is_clinch.mean()),
        frac_distance=float(is_distance.mean()),
        mean_separation=float(sep.mean()),
        p90_separation=float(np.percentile(sep, 90)),
        separation_volatility=float(np.diff(sep).std()) if scored > 1 else 0.0,
        mean_tilt=float(np.nanmean(tilts)) if np.any(~np.isnan(tilts)) else float("nan"),
    )

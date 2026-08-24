"""Who is who, by the colour of the shorts.

Frame-to-frame tracking was the obvious route and it failed: 37% top-2
persistence at 5 fps, 41% at 15, so more frames buy nothing (see
artifacts/tracking_probe.txt). The reason is structural. A tracker
assumes continuity, and the moment that matters most — one fighter
disappearing underneath the other — is exactly when continuity breaks.

Appearance has the opposite property. A fighter who vanishes under his
opponent for twenty seconds comes back wearing the same shorts. Nothing
has to be remembered between frames, so nothing is lost when frames go
wrong.

This module does not claim it works. It measures whether it can.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

L_SHOULDER, R_SHOULDER = 5, 6
L_HIP, R_HIP = 11, 12
L_KNEE, R_KNEE = 13, 14

MIN_KP_CONF = 0.30

# The shorts sit between hip and knee. Sample the middle of that span and
# a narrow column of it, to stay off the skin at either edge.
THIGH_FRACTION = (0.25, 0.65)
WIDTH_FRACTION = 0.95

# Fewer pixels than this and the patch is a guess about a guess.
MIN_PATCH_PIXELS = 40

# A median over the whole patch averages shorts with skin, canvas and
# whatever the crowd is wearing, and the average of red fabric and pale
# thigh is a grey that means nothing. Measured on Lesnar vs Mir — bright
# red against white — 42% of patches came back with saturation under 60,
# and the median hue gap between the two fighters was 14 out of 90 on a
# pairing that should be trivial.
#
# So: keep only pixels with enough colour to be fabric, and take the
# MODE of those rather than the median of everything.
MIN_PIXEL_SAT = 70
HUE_BINS = 18
MIN_COLOURED_FRACTION = 0.12

# When the knees are not resolvable, walk down the body axis instead.
# Shorts end roughly half a torso below the hips.
THIGH_FROM_TORSO = 0.55

# Decoding every frame to read a colour is wasteful; configuration
# changes slowly and shorts do not change at all.
FRAME_STRIDE = 4


@dataclass(frozen=True)
class IdentityReport:
    video_id: str
    frames_sampled: int
    patches: int
    separation: float        # distance between the two colour modes
    within_scatter: float    # mean spread inside a mode
    contrast: float          # separation / within_scatter — the real number
    disagreement: float      # of two-body frames, how often the pair splits
    usable: bool


def _patch_box(kx, ky, kc) -> tuple[int, int, int, int] | None:
    """Pixel box over the shorts, or None if the hips are not resolvable.

    Knees are preferred but NOT required, and that distinction is the
    whole module. The first version demanded them, and on Lesnar vs Mir
    it silently refused to sample the single most distinctive garment in
    the frame — Mir's red shorts — because his legs tracked badly. The
    fighters whose limbs the detector loses are exactly the fighters
    whose identity is hardest, so a rule that drops them is worse than
    useless: it removes the hard cases and then reports success.

    Without knees, walk down the torso axis instead. Shoulders-to-hips
    is the most reliably detected segment on a body, and it points the
    right way whether the fighter is standing or flat on his back.
    """
    if min(kc[L_HIP], kc[R_HIP]) < MIN_KP_CONF:
        return None

    hx = (kx[L_HIP] + kx[R_HIP]) / 2.0
    hy = (ky[L_HIP] + ky[R_HIP]) / 2.0

    hip_w = abs(kx[L_HIP] - kx[R_HIP])

    knees = [(kx[i], ky[i]) for i in (L_KNEE, R_KNEE) if kc[i] >= MIN_KP_CONF]
    if knees:
        nx = float(np.mean([p[0] for p in knees]))
        ny = float(np.mean([p[1] for p in knees]))
    elif min(kc[L_SHOULDER], kc[R_SHOULDER]) >= MIN_KP_CONF:
        sx = (kx[L_SHOULDER] + kx[R_SHOULDER]) / 2.0
        sy = (ky[L_SHOULDER] + ky[R_SHOULDER]) / 2.0
        # Hips-minus-shoulders points from head to feet, in any pose.
        nx = hx + (hx - sx) * THIGH_FROM_TORSO
        ny = hy + (hy - sy) * THIGH_FROM_TORSO
        if hip_w < 4:
            hip_w = float(np.hypot(hx - sx, hy - sy)) * 0.6
    else:
        return None

    if hip_w < 4:
        return None

    lo, hi = THIGH_FRACTION
    x0 = hx + (nx - hx) * lo
    y0 = hy + (ny - hy) * lo
    x1 = hx + (nx - hx) * hi
    y1 = hy + (ny - hy) * hi
    half = hip_w * WIDTH_FRACTION / 2.0

    left = int(min(x0, x1) - half)
    right = int(max(x0, x1) + half)
    top = int(min(y0, y1))
    bottom = int(max(y0, y1))
    return left, top, right, bottom


def sample_colours(video_path, skeletons: pd.DataFrame) -> pd.DataFrame:
    """One median HSV per detected body, on a strided set of frames."""
    import cv2

    wanted = {
        int(f) for f in skeletons["frame_idx"].unique() if int(f) % FRAME_STRIDE == 0
    }
    by_frame = {int(k): v for k, v in skeletons.groupby("frame_idx") if int(k) in wanted}

    cap = cv2.VideoCapture(str(video_path))
    rows: list[dict] = []
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        group = by_frame.get(idx)
        if group is not None:
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
            h, w = hsv.shape[:2]
            for _, r in group.iterrows():
                box = _patch_box(
                    np.asarray(r["kx"], float),
                    np.asarray(r["ky"], float),
                    np.asarray(r["kc"], float),
                )
                if box is None:
                    continue
                x0, y0, x1, y1 = box
                x0, y0 = max(0, x0), max(0, y0)
                x1, y1 = min(w, x1), min(h, y1)
                if (x1 - x0) * (y1 - y0) < MIN_PATCH_PIXELS:
                    continue
                patch = hsv[y0:y1, x0:x1].reshape(-1, 3)
                coloured = patch[patch[:, 1] >= MIN_PIXEL_SAT]
                if len(coloured) < max(MIN_PATCH_PIXELS // 2,
                                       MIN_COLOURED_FRACTION * len(patch)):
                    # Genuinely drab shorts, or a patch that missed the
                    # fabric. Either way there is no colour to read, and
                    # inventing one is how a grey average masquerades as
                    # an identity.
                    continue
                hist = np.bincount(
                    (coloured[:, 0].astype(int) * HUE_BINS) // 180,
                    minlength=HUE_BINS,
                )
                dominant = int(np.argmax(hist))
                keep = coloured[
                    (coloured[:, 0].astype(int) * HUE_BINS) // 180 == dominant
                ]
                rows.append(
                    {
                        "frame_idx": idx,
                        "person_rank": int(r["person_rank"]),
                        "h": float(np.median(keep[:, 0])),
                        "s": float(np.median(keep[:, 1])),
                        "v": float(np.median(keep[:, 2])),
                        "pixels": len(keep),
                        "coloured_fraction": len(coloured) / len(patch),
                    }
                )
        idx += 1
    cap.release()
    return pd.DataFrame(rows)


def _features(df: pd.DataFrame) -> np.ndarray:
    """Hue on a circle, so red at 179 and red at 0 are the same colour."""
    hue = df["h"].to_numpy() * (2 * np.pi / 180.0)
    sat = df["s"].to_numpy() / 255.0
    val = df["v"].to_numpy() / 255.0
    # Weight hue by saturation: the hue of a grey pixel is meaningless,
    # and black shorts against black shorts is the case that must be
    # allowed to fail loudly rather than quietly.
    return np.column_stack([np.cos(hue) * sat, np.sin(hue) * sat, val])


def _pair_axis(x: np.ndarray, pairs: list[tuple[int, int]]) -> np.ndarray | None:
    """The colour direction that best separates the two bodies in a frame.

    Free k-means was the wrong tool and it failed in a diagnostic way:
    one fight split at 0.22, BELOW the 0.50 a coin would give, meaning it
    was putting both fighters in the SAME group more often than chance.
    It had found a real axis of variation — lighting, close-up versus
    wide, standing versus grounded — that both fighters share at any
    instant, and which therefore says nothing about which is which.

    The constraint the clustering was ignoring is the strongest fact we
    have: in a frame holding both fighters, they are BY DEFINITION not
    the same fighter. So instead of asking colours to fall into two
    heaps, ask which direction the within-frame differences point along.

    Each difference d = colour(a) - colour(b) carries the right axis with
    an arbitrary sign, since which body is "a" flips with camera
    distance. Summing d dᵀ discards that sign — it is the same matrix for
    d and -d — and its leading eigenvector is the axis those differences
    agree on.
    """
    if len(pairs) < 8:
        return None
    d = np.stack([x[i] - x[j] for i, j in pairs])
    m = d.T @ d
    vals, vecs = np.linalg.eigh(m)
    w = vecs[:, int(np.argmax(vals))]
    return w / (np.linalg.norm(w) + 1e-12)


def analyse(video_id: str, colours: pd.DataFrame) -> IdentityReport:
    if len(colours) < 50:
        return IdentityReport(video_id, 0, len(colours), *([float("nan")] * 3), False)

    x = _features(colours)
    colours = colours.reset_index(drop=True)

    # Row indices of the two measured bodies, per frame that has both.
    lead = colours.index[colours["person_rank"] == 0]
    second = colours.index[colours["person_rank"] == 1]
    by_frame_a = dict(zip(colours.loc[lead, "frame_idx"], lead))
    by_frame_b = dict(zip(colours.loc[second, "frame_idx"], second))
    pairs = [(by_frame_a[f], by_frame_b[f])
             for f in by_frame_a if f in by_frame_b]

    w = _pair_axis(x, pairs)
    if w is None:
        return IdentityReport(video_id, int(colours["frame_idx"].nunique()),
                              len(colours), *([float("nan")] * 3), False)

    proj = x @ w
    cut = float(np.median(proj))
    labels = (proj > cut).astype(int)

    hi, lo = proj[labels == 1], proj[labels == 0]
    separation = float(abs(hi.mean() - lo.mean())) if len(hi) and len(lo) else 0.0
    within = float(np.mean([hi.std() if len(hi) else 0.0,
                            lo.std() if len(lo) else 0.0]))
    contrast = separation / within if within > 1e-6 else 0.0

    # The honest test, and it needs no labels: in a frame holding both
    # fighters, the two bodies must land on opposite sides. Chance is
    # 50%. Anything near that means the colours carry no identity.
    split = [labels[i] != labels[j] for i, j in pairs]
    disagreement = float(np.mean(split)) if split else float("nan")

    return IdentityReport(
        video_id=video_id,
        frames_sampled=int(colours["frame_idx"].nunique()),
        patches=len(colours),
        separation=separation,
        within_scatter=within,
        contrast=contrast,
        disagreement=disagreement,
        # Pre-registered, same discipline as the pose gate: the pair must
        # split on 80% of frames where both are visible. 50% is a coin.
        usable=bool(disagreement >= 0.80) if disagreement == disagreement else False,
    )

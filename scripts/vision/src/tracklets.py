"""Merge track fragments into two fighters.

The per-frame approach failed for a reason worth stating: it threw away
the strongest constraint in the problem. Two bodies visible in the SAME
frame cannot be the same fighter. That is free, exact, and it says
nothing about colour, lighting or pose.

So: build a graph whose edges are "these two tracklets were on screen
together", and two-colour it. Appearance is then needed only where the
graph falls apart into pieces that never co-occur — which is exactly
the situation appearance is good at and per-frame colour was not,
because a tracklet carries 15-70 frames to average over instead of one.

Nothing here assumes the graph is clean. A referee tracked as a fighter,
or a detector error, puts an odd cycle in it, and how badly the graph
resists two-colouring is itself the signal that something is wrong.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# A tracklet shorter than this is noise: a flicker on a cornerman, a
# detection on the crowd. Long enough to matter, short enough to keep
# the fragments we actually need to merge.
MIN_TRACKLET_FRAMES = 5

# Fighter candidates are the big boxes. The crowd and the corner are
# small and peripheral; the referee is neither, which is why he has to
# be handled by the graph rather than by a size cut.
AREA_PERCENTILE = 60

# Held-out frames for validation. The graph is built from the rest, so
# the split rate below is measured on co-occurrences the colouring
# never saw — otherwise two-colouring a graph and then testing on its
# own edges scores 100% by construction and means nothing.
HOLDOUT_FRACTION = 0.30
SEED = 7


@dataclass(frozen=True)
class MergeReport:
    video_id: str
    tracklets: int
    candidates: int
    edges: int
    components: int
    frustration: float      # share of edges a 2-colouring must violate
    holdout_pairs: int
    holdout_split: float    # THE number: split rate on unseen frames
    usable: bool


def build(detections: pd.DataFrame) -> tuple[list[int], dict, dict]:
    """Group per-frame detections into tracklets keyed by track id."""
    frames: dict[int, list[int]] = {}
    areas: dict[int, list[float]] = {}
    for tid, group in detections.groupby("track_id"):
        if len(group) < MIN_TRACKLET_FRAMES:
            continue
        frames[int(tid)] = group["frame_idx"].astype(int).tolist()
        areas[int(tid)] = group["area"].astype(float).tolist()
    order = sorted(frames, key=lambda t: -float(np.mean(areas[t])))
    return order, frames, areas


def _candidates(order: list[int], areas: dict) -> list[int]:
    if not order:
        return []
    means = np.array([np.mean(areas[t]) for t in order])
    cut = np.percentile(means, AREA_PERCENTILE)
    return [t for t in order if np.mean(areas[t]) >= cut]


def _cooccurrence(cands: list[int], frames: dict, skip: set[int]):
    """Edges = tracklets seen together, ignoring held-out frames."""
    seen: dict[int, set[int]] = {
        t: {f for f in frames[t] if f not in skip} for t in cands
    }
    edges: dict[tuple[int, int], int] = {}
    for i, a in enumerate(cands):
        for b in cands[i + 1:]:
            n = len(seen[a] & seen[b])
            if n:
                edges[(a, b)] = n
    return edges


def _two_colour(cands: list[int], edges: dict) -> tuple[dict[int, int], float, int]:
    """Two-colour so that co-occurring tracklets land on OPPOSITE sides.

    This is a maximum cut, not a minimum one, and getting that backwards
    is not a subtle error. An edge here means "these two were on screen
    together, so they are different fighters" — the colouring has to put
    almost every edge ACROSS the boundary. The Fiedler vector solves the
    opposite problem, keeping connected things together, and it showed:
    frustration 0.98, holdout split 0.08, both pinned at the wrong end
    of their range rather than merely poor.

    The leading eigenvector of the Laplacian is the max-cut relaxation.
    """
    idx = {t: i for i, t in enumerate(cands)}
    n = len(cands)
    if n < 2:
        return {t: 0 for t in cands}, 0.0, 1

    w = np.zeros((n, n))
    for (a, b), c in edges.items():
        w[idx[a], idx[b]] = w[idx[b], idx[a]] = float(c)

    deg = w.sum(axis=1)
    lap = np.diag(deg) - w
    vals, vecs = np.linalg.eigh(lap)
    components = int((vals < 1e-9).sum())   # zero eigenvalues count pieces
    labels = {t: int(vecs[idx[t], -1] > 0) for t in cands}

    total = sum(edges.values())
    violated = sum(c for (a, b), c in edges.items() if labels[a] == labels[b])
    frustration = violated / total if total else 0.0
    return labels, frustration, components


def merge(video_id: str, detections: pd.DataFrame) -> tuple[MergeReport, dict[int, int]]:
    rng = np.random.default_rng(SEED)
    all_frames = detections["frame_idx"].astype(int).unique()
    holdout = set(
        rng.choice(all_frames, max(1, int(len(all_frames) * HOLDOUT_FRACTION)),
                   replace=False).tolist()
    )

    order, frames, areas = build(detections)
    cands = _candidates(order, areas)
    if len(cands) < 2:
        return MergeReport(video_id, len(order), len(cands), 0, 0,
                           float("nan"), 0, float("nan"), False), {}

    edges = _cooccurrence(cands, frames, skip=holdout)
    labels, frustration, components = _two_colour(cands, edges)

    # Validation on frames the graph never saw.
    held = detections[detections["frame_idx"].isin(holdout)]
    held = held[held["track_id"].isin(labels)]
    split_hits = split_total = 0
    for _, g in held.groupby("frame_idx"):
        g = g.sort_values("area", ascending=False).head(2)
        if len(g) < 2:
            continue
        a, b = (int(t) for t in g["track_id"])
        split_total += 1
        if labels[a] != labels[b]:
            split_hits += 1

    holdout_split = split_hits / split_total if split_total else float("nan")
    return (
        MergeReport(
            video_id=video_id,
            tracklets=len(order),
            candidates=len(cands),
            edges=len(edges),
            components=components,
            frustration=frustration,
            holdout_pairs=split_total,
            holdout_split=holdout_split,
            # Same bar as every other gate here: 0.80, 0.50 is a coin.
            usable=bool(holdout_split >= 0.80) if holdout_split == holdout_split else False,
        ),
        labels,
    )

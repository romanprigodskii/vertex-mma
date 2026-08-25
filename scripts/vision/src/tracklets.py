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

# A fighter is not merely a big box — he is one of the two BIGGEST
# boxes in the frames where he appears. That distinction matters because
# an absolute size cut has no idea the camera zooms: it drops a fighter
# who is far away and admits a cornerman who is close. Measured, the
# absolute cut left 672 candidate tracklets on a two-fighter bout and
# 58% of the co-occurrence graph unsatisfiable, because a man in the
# front row is "seen together" with everyone and can be nobody's
# opponent.
#
# Frame-relative rank has no such blind spot, and it costs nothing.
TOP2_FRACTION = 0.50

# Held-out frames for validation. The graph is built from the rest, so
# the split rate below is measured on co-occurrences the colouring
# never saw — otherwise two-colouring a graph and then testing on its
# own edges scores 100% by construction and means nothing.
HOLDOUT_FRACTION = 0.30
SEED = 7

# Appearance is only asked ONE question per disconnected component:
# does its colouring line up with the reference component, or is it
# flipped? That is a single bit against hundreds of frames of evidence,
# which is why it can work here after per-frame colour failed — there
# the same descriptor had to carry a decision per frame.
APPEARANCE_BINS = 12
MIN_GROUP_FRAMES = 15
BOX_INSET = 0.25          # keep the middle of the box, drop the background


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


def _candidates(detections: pd.DataFrame, frames: dict) -> list[int]:
    """Tracklets that are routinely one of the two biggest bodies on screen."""
    if not frames:
        return []
    ranked = (
        detections.sort_values("area", ascending=False)
        .groupby("frame_idx")
        .head(2)["track_id"]
        .astype(int)
    )
    top2_counts = ranked.value_counts().to_dict()
    out = []
    for t, fs in frames.items():
        share = top2_counts.get(t, 0) / len(fs)
        if share >= TOP2_FRACTION:
            out.append(t)
    return sorted(out, key=lambda t: -len(frames[t]))


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

    # The spectral cut is a relaxation and stops short of the real
    # optimum. Frustration measured 0.22-0.33 on real fights — those are
    # co-occurrence constraints being violated INSIDE a component, where
    # the graph does have an opinion and the colouring is ignoring it.
    #
    # A greedy pass fixes what the relaxation left on the table: flip any
    # single node that reduces the violated weight, repeat until nothing
    # helps. Local optima are a risk in general; here the objective is
    # exact and cheap to evaluate, so the pass costs nothing and can only
    # move frustration down.
    adjacency: dict[int, list[tuple[int, float]]] = {t: [] for t in cands}
    for (a, b), c in edges.items():
        adjacency[a].append((b, float(c)))
        adjacency[b].append((a, float(c)))

    for _ in range(20):
        moved = False
        for t in cands:
            same = sum(c for u, c in adjacency[t] if labels[u] == labels[t])
            other = sum(c for u, c in adjacency[t] if labels[u] != labels[t])
            if same > other:            # violating more weight than it satisfies
                labels[t] = 1 - labels[t]
                moved = True
        if not moved:
            break

    total = sum(edges.values())
    violated = sum(c for (a, b), c in edges.items() if labels[a] == labels[b])
    frustration = violated / total if total else 0.0
    return labels, frustration, components


def _components(cands: list[int], edges: dict) -> dict[int, int]:
    """Connected components of the co-occurrence graph, by union-find."""
    parent = {t: t for t in cands}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for (a, b) in edges:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    roots = {}
    out = {}
    for t in cands:
        r = find(t)
        out[t] = roots.setdefault(r, len(roots))
    return out


def link_components(labels: dict[int, int], comp_of: dict[int, int],
                    signatures: dict[int, np.ndarray]) -> dict[int, int]:
    """Decide, per component, whether its two colours are flipped.

    Within a component the colouring is pinned by the co-occurrence
    constraint. Across components there is no constraint at all — they
    never shared a frame — so the graph is silent and something else has
    to speak. Each component contributes exactly one bit.
    """
    comps = sorted(set(comp_of.values()))
    if len(comps) < 2:
        return labels

    def group_sig(comp: int, colour: int) -> np.ndarray | None:
        sigs = [signatures[t] for t in labels
                if comp_of[t] == comp and labels[t] == colour and t in signatures]
        return np.mean(sigs, axis=0) if sigs else None

    # The biggest component is the reference; everything aligns to it.
    sizes = {c: sum(1 for t in comp_of if comp_of[t] == c) for c in comps}
    ref = max(sizes, key=sizes.get)
    ref_sig = {c: group_sig(ref, c) for c in (0, 1)}
    if ref_sig[0] is None or ref_sig[1] is None:
        return labels

    out = dict(labels)
    for comp in comps:
        if comp == ref:
            continue
        a, b = group_sig(comp, 0), group_sig(comp, 1)
        if a is None or b is None:
            continue
        keep = np.dot(a, ref_sig[0]) + np.dot(b, ref_sig[1])
        flip = np.dot(a, ref_sig[1]) + np.dot(b, ref_sig[0])
        if flip > keep:
            for t in comp_of:
                if comp_of[t] == comp:
                    out[t] = 1 - out[t]
    return out


def merge(video_id: str, detections: pd.DataFrame,
          signatures: dict[int, np.ndarray] | None = None) -> tuple[MergeReport, dict[int, int]]:
    rng = np.random.default_rng(SEED)
    all_frames = detections["frame_idx"].astype(int).unique()
    holdout = set(
        rng.choice(all_frames, max(1, int(len(all_frames) * HOLDOUT_FRACTION)),
                   replace=False).tolist()
    )

    order, frames, areas = build(detections)
    cands = _candidates(detections, frames)
    if len(cands) < 2:
        return MergeReport(video_id, len(order), len(cands), 0, 0,
                           float("nan"), 0, float("nan"), False), {}

    edges = _cooccurrence(cands, frames, skip=holdout)
    labels, frustration, components = _two_colour(cands, edges)

    if signatures:
        comp_of = _components(cands, edges)
        components = len(set(comp_of.values()))
        labels = link_components(labels, comp_of, signatures)

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

"""Put a name on each of the two groups.

Tracklet merging answers "these are two different people". It cannot
answer "and this one is Poirier", because nothing in the pixels knows
his name. That gap matters the moment we want a trajectory: a group in a
2019 bout and a group in a 2023 bout have to be the same man, or the
series is noise.

The anchor is the same one the pose gate used — UFCStats per-fighter
round data, which the vision pipeline never sees. Control time says
which corner spent the fight on top; the pose says which GROUP spent it
on top. Line them up.

Two properties make this honest. The assignment is falsifiable: the two
possible pairings score differently, and how differently is a confidence
we can report and threshold on. And it is external: nothing here is
fitted to the outcome we later want to predict.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# Below this the two pairings are nearly as good as each other, and a
# coin-flip attribution poisons every trajectory it touches. Better to
# drop the fight and say so.
MIN_MARGIN = 0.15


@dataclass(frozen=True)
class Attribution:
    bout_id: str
    group_for_a: int | None      # which pose group is fighter A
    margin: float                # how much better than the alternative
    confident: bool
    grounded_a: float            # pose-measured, for the winning assignment
    grounded_b: float


def group_ground_share(labels: dict[int, int],
                       per_track: pd.DataFrame) -> dict[int, float]:
    """Share of a group's frames where that body reads as grounded."""
    out = {}
    for g in (0, 1):
        tracks = [t for t, lab in labels.items() if lab == g]
        rows = per_track[per_track["track_id"].isin(tracks)]
        out[g] = float(rows["grounded"].mean()) if len(rows) else float("nan")
    return out


def _group_mean(labels: dict[int, int], per_track: pd.DataFrame,
                column: str) -> dict[int, float]:
    out = {}
    for g in (0, 1):
        tracks = [t for t, lab in labels.items() if lab == g]
        rows = per_track[per_track["track_id"].isin(tracks)]
        vals = rows[column].dropna()
        w = rows.loc[vals.index, "frames"].to_numpy(dtype=float)
        out[g] = float(np.average(vals, weights=w)) if len(vals) else float("nan")
    return out


def attribute(bout_id: str, labels: dict[int, int], per_track: pd.DataFrame,
              control_a: float, control_b: float,
              sig_a: float = 0.0, sig_b: float = 0.0) -> Attribution:
    """Match pose groups to fighters against two independent anchors.

    Control time was the obvious one — the corner that controlled is the
    corner on top, and the group on top is the one reading grounded less
    often. It is also strongly asymmetric in real fights: median 0.89
    across this corpus, above 0.3 in 92% of bouts.

    But it is silent exactly where nothing happens on the mat. In a
    striking match neither group is grounded, both shares sit near zero,
    and the product collapses — Costa vs Kopylov scored a margin of 0.07
    for that reason, not because the anchor was weak.

    So a second pairing: significant strikes against movement. The busier
    fighter lands more, and movement is measurable whether or not anyone
    goes down. Each anchor contributes in proportion to how asymmetric it
    is in THIS fight, so a grappling match leans on control and a
    kickboxing match leans on output.
    """
    share = group_ground_share(labels, per_track)
    move = _group_mean(labels, per_track, "movement")
    if any(np.isnan(v) for v in share.values()):
        return Attribution(bout_id, None, 0.0, False, float("nan"), float("nan"))

    def signed_share(a: float, b: float) -> float:
        total = a + b
        return (a - b) / total if total > 0 else 0.0

    ctrl_gap = signed_share(control_a, control_b)
    sig_gap = signed_share(sig_a, sig_b)

    def score(g_for_a: int) -> float:
        g_for_b = 1 - g_for_a
        s = ctrl_gap * (share[g_for_b] - share[g_for_a])
        if not any(np.isnan(v) for v in move.values()):
            s += sig_gap * (move[g_for_a] - move[g_for_b])
        return s

    s0, s1 = score(0), score(1)
    best = 0 if s0 >= s1 else 1
    margin = abs(s0 - s1)
    return Attribution(
        bout_id=bout_id,
        group_for_a=best,
        margin=margin,
        confident=margin >= MIN_MARGIN,
        grounded_a=share[best],
        grounded_b=share[1 - best],
    )

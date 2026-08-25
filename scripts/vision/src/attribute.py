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


def attribute(bout_id: str, labels: dict[int, int], per_track: pd.DataFrame,
              control_a: float, control_b: float) -> Attribution:
    """Match pose groups to fighters using control time as the anchor.

    control_* are each corner's share of control time from UFCStats. The
    fighter who controlled is the one on top, and the group on top is the
    one whose bodies read grounded LESS often — being underneath is what
    the aspect test picks up.
    """
    share = group_ground_share(labels, per_track)
    if any(np.isnan(v) for v in share.values()):
        return Attribution(bout_id, None, 0.0, False, float("nan"), float("nan"))

    # Two candidate pairings. Score each by how well "controls more"
    # lines up with "is underneath less".
    total = control_a + control_b
    if total <= 0:
        return Attribution(bout_id, None, 0.0, False, share[0], share[1])
    ca, cb = control_a / total, control_b / total

    def score(g_for_a: int) -> float:
        g_for_b = 1 - g_for_a
        # Positive when the better-controlling corner is the less
        # grounded group.
        return (ca - cb) * (share[g_for_b] - share[g_for_a])

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

"""Fitted decision-winner model — replaces `monte_carlo._decision_logit`.

The incumbent is four weights set by hand:

    0.18*(slpm_a - slpm_b) + 0.10*(sapm_b - sapm_a)
    + 0.8*(control_per_min_a - control_per_min_b)
    + 0.08*(td_per15_a - td_per15_b)

pushed through sigmoid(logit / DECISION_TEMPERATURE) with a temperature of
0.45, i.e. SHARPENED by a factor of 2.2. Stage 1 of the round lab measured
what that costs. Grading the Monte Carlo's conditional method mix with the
decision cell split 50/50 gives log-loss 0.91-0.98; grading the identical
hazards with this split instead gives 3.42-3.52, against 1.02 for a constant
base-rate predictor. The finish hazards were never the problem — an
overconfident decision-winner split was, and METHOD_ANCHOR_LAMBDA=0.80 has
been paying for it by throwing away 80% of the per-fight signal.

Why the split matters at all, given `sportsbook.ts` takes the winner LEVEL
from the ensemble: `reconcileMethodProbs` rescales each side's (ko, sub, dec)
to that side's ensemble probability, so the MC only supplies the RATIO within
a side. If the MC says A takes the decision with p=0.95, side B's cells are
left almost pure finish, and B's method market is priced off that.

Design
------
* Inputs are strictly A-B differences of `FighterMC` fields — the same
  pre-fight career numbers the simulator already holds. No realized in-fight
  statistics: those are unavailable at serve time and would be a train/serve
  distribution swap that `ensemble.py`'s `calibrator = None` cannot catch.
* Logistic regression with NO INTERCEPT on those differences. That makes the
  model exactly antisymmetric — p(A beats B) == 1 - p(B beats A) as an
  algebraic identity, not something that has to be enforced by averaging both
  orderings at serve time.
* The temperature stays as a separate module-level float so it can be swept
  the same way METHOD_ANCHOR_LAMBDA was. A well-fitted logistic wants 1.0; a
  value below 1 means the sweep found the fit under-confident on held-out
  data, and above 1 means over-confident.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

# Every FighterMC field. The hand-set logit used four of them; there is no
# reason to pre-judge which matter when the fit can be regularized instead.
DECISION_FEATURES = (
    "slpm",
    "sapm",
    "kd_per_fight",
    "sub_per15",
    "td_per15",
    "td_def",
    "control_per_min",
    "losses_ko_rate",
    "losses_sub_rate",
    "finish_rate_for",
)


def decision_diffs(a: Any, b: Any) -> np.ndarray:
    """A-B differences of the FighterMC fields. Accepts FighterMC or dict."""

    def get(obj: Any, key: str) -> float:
        v = obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)
        try:
            fv = float(v)
        except (TypeError, ValueError):
            return 0.0
        return fv if np.isfinite(fv) else 0.0

    return np.asarray(
        [get(a, f) - get(b, f) for f in DECISION_FEATURES], dtype=float
    )


@dataclass
class DecisionWinnerModel:
    coef: list[float] = field(default_factory=list)
    # Per-feature SCALE only, never a location shift: (x_a - mu) - (x_b - mu)
    # cancels, so centering is a no-op on differences, while subtracting a mean
    # from the difference itself would break the antisymmetry the no-intercept
    # fit buys.
    scale: list[float] = field(default_factory=list)
    feature_names: list[str] = field(default_factory=list)
    temperature: float = 1.0
    meta: dict[str, Any] = field(default_factory=dict)

    def logit(self, a: Any, b: Any) -> float:
        x = decision_diffs(a, b) / np.asarray(self.scale)
        return float(np.dot(x, np.asarray(self.coef)))

    def prob_a(self, a: Any, b: Any, temperature: float | None = None) -> float:
        t = self.temperature if temperature is None else temperature
        z = self.logit(a, b) / max(t, 1e-6)
        # Guard the exp so an extreme matchup can't overflow.
        z = max(-30.0, min(30.0, z))
        return 1.0 / (1.0 + math.exp(-z))

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "coef": self.coef,
                    "scale": self.scale,
                    "feature_names": self.feature_names,
                    "temperature": self.temperature,
                    "meta": self.meta,
                },
                indent=2,
            )
        )

    @classmethod
    def load(cls, path: Path) -> DecisionWinnerModel:
        return cls(**json.loads(Path(path).read_text()))

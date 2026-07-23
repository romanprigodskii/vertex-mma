"""Discrete-time competing-risks finish hazard, fitted from data.

What this replaces
------------------
`src/monte_carlo.py` decides WHEN and HOW a fight ends from ten hand-set
constants: DAMAGE_GAMMA, DAMAGE_FLOOR, ROUND_RAMP, POWER_TILT, GAMMA_MIN/MAX,
KO/SUB_TOTAL_SCALE and the four lift weights. None of them was ever fitted;
they were tuned by eye against marginal finish rates. The calibration record
says what that cost: `calibrate_method_mix.py` found the raw per-fight method
mix scored a conditional log-loss of 1.38 against 1.018 for a CONSTANT
base-rate predictor, and the fix was to anchor 80% of the way back to the base
rates (METHOD_ANCHOR_LAMBDA = 0.80). In other words the per-fight method signal
was mostly noise, and the fixed-odds book quotes those prices.

Model
-----
Cause-specific hazards on a discrete grid, one direction per attacker:

    log lambda_c(t | att, def) = alpha_c(t) + beta_c . x(att, def, ctx)

for c in {ko, sub}, where lambda is a per-SECOND rate and alpha_c(t) is a
piecewise-linear baseline in ABSOLUTE elapsed time plus a within-round ramp.

Two deliberate choices:

* The clock is absolute elapsed seconds, NOT the fraction-of-fight tau the
  current MC uses. tau confounds 3-round and 5-round bouts: a 5-rounder's
  minute 12 is mid-fight on the tau clock and late-fight on the real one. With
  an absolute clock a 5-rounder simply spends more time at risk, and any
  genuine championship-round effect has to show up as a coefficient rather
  than being smuggled in by rescaling. This is why LENGTH_FINISH_BONUS is not
  fitted from the 3r-vs-5r contrast: all 899 five-rounders are main events or
  title fights, so that contrast is confounded with fighter quality and pace.
  `scheduled_rounds`, `is_main_event` and `is_title_fight` are covariates so
  the length effect cannot absorb card position.
* Competing risks are handled cause-specifically: each hazard is fitted with
  the other outcome treated as censoring. That is exactly the structure the
  Monte Carlo consumes (four independent per-tick hazards racing), so the fit
  and the simulator agree by construction.

Covariates come ONLY from `FighterMC` fields plus bout context, so anything
fitted here is available at serve time. No realized in-fight statistics: those
would be a train/serve distribution swap that `ensemble.py`'s `calibrator =
None` would not catch, and the overconfidence would land in
`bout_simulation_rounds` and then in `src/lib/sportsbook.ts`.

Fitting is Poisson regression with exposure (sklearn PoissonRegressor on
rate = events / exposure, weighted by exposure — the standard offset trick),
L2-penalized, penalty chosen on the validation window.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

SECONDS_PER_ROUND = 300
# Grid resolution for the person-period expansion. 15s keeps the design matrix
# at ~1.5M rows for the full history while being far finer than the round
# granularity anything downstream cares about.
BIN_SECONDS = 15
# Knots for the piecewise-linear baseline log-hazard, in elapsed MINUTES.
TIME_KNOTS = (5.0, 10.0, 15.0, 20.0)

# Attacker-side and defender-side covariates. Every name is a FighterMC field,
# which is the guarantee that the fit can actually be served.
ATT_FEATURES = (
    "kd_per_fight",
    "sub_per15",
    "slpm",
    "td_per15",
    "control_per_min",
    "finish_rate_for",
)
DEF_FEATURES = (
    "losses_ko_rate",
    "losses_sub_rate",
    "sapm",
    "td_def",
)
CTX_FEATURES = ("scheduled_rounds", "is_main_event", "is_title_fight")

# Rate-like covariates are right-skewed with the odd blow-up from a tiny
# denominator; log1p keeps a 3-knockdown-per-fight outlier from dominating the
# linear predictor. The [0, 1] rates are left alone.
_LOG1P = {"kd_per_fight", "sub_per15", "slpm", "td_per15", "sapm"}


def design_columns() -> list[str]:
    """Column order of the covariate block (time basis excluded)."""
    return (
        [f"att_{f}" for f in ATT_FEATURES]
        + [f"def_{f}" for f in DEF_FEATURES]
        + list(CTX_FEATURES)
    )


def time_basis(elapsed_seconds: np.ndarray) -> np.ndarray:
    """Piecewise-linear baseline basis over ABSOLUTE elapsed time, plus the
    within-round position. Columns:
        [minutes, hinge(k) for k in TIME_KNOTS..., round_frac]
    The intercept is supplied by the regressor."""
    t = np.asarray(elapsed_seconds, dtype=float)
    minutes = t / 60.0
    cols = [minutes]
    cols.extend(np.maximum(0.0, minutes - k) for k in TIME_KNOTS)
    cols.append((t % SECONDS_PER_ROUND) / SECONDS_PER_ROUND)
    return np.column_stack(cols)


def time_basis_names() -> list[str]:
    return ["minutes", *[f"hinge_{k:g}min" for k in TIME_KNOTS], "round_frac"]


def covariate_row(
    att: dict[str, Any] | Any,
    deff: dict[str, Any] | Any,
    scheduled_rounds: int,
    is_main_event: bool = False,
    is_title_fight: bool = False,
) -> np.ndarray:
    """One covariate vector for the direction att -> def. Accepts either a
    FighterMC (attribute access) or a plain dict."""

    def get(obj: Any, key: str) -> float:
        v = obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)
        try:
            fv = float(v)
        except (TypeError, ValueError):
            return 0.0
        if not np.isfinite(fv):
            return 0.0
        return np.log1p(max(fv, 0.0)) if key in _LOG1P else fv

    vals = [get(att, f) for f in ATT_FEATURES]
    vals += [get(deff, f) for f in DEF_FEATURES]
    vals += [float(scheduled_rounds), float(bool(is_main_event)), float(bool(is_title_fight))]
    return np.asarray(vals, dtype=float)


@dataclass
class FinishHazardModel:
    """Fitted cause-specific hazards. `predict_rates` returns per-SECOND KO and
    submission hazards on a 1-second grid — the shape monte_carlo.simulate_bout
    consumes directly."""

    coef: dict[str, list[float]] = field(default_factory=dict)
    intercept: dict[str, float] = field(default_factory=dict)
    cov_mean: list[float] = field(default_factory=list)
    cov_std: list[float] = field(default_factory=list)
    cov_names: list[str] = field(default_factory=list)
    time_names: list[str] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    # ── prediction ─────────────────────────────────────────────────────

    def _linear(self, cause: str, T: np.ndarray, x_scaled: np.ndarray) -> np.ndarray:
        w = np.asarray(self.coef[cause], dtype=float)
        n_time = len(self.time_names)
        eta = T @ w[:n_time] + float(x_scaled @ w[n_time:]) + self.intercept[cause]
        return eta

    def predict_rates(
        self,
        att: Any,
        deff: Any,
        scheduled_rounds: int,
        is_main_event: bool = False,
        is_title_fight: bool = False,
        total_seconds: int | None = None,
    ) -> tuple[np.ndarray, np.ndarray]:
        """(ko_hazard, sub_hazard) per second for att finishing def, length
        `total_seconds` (defaults to the full scheduled fight)."""
        n = total_seconds or scheduled_rounds * SECONDS_PER_ROUND
        # Mid-bin evaluation on the second grid: hazards are smooth, so the
        # exact within-second offset is irrelevant.
        T = time_basis(np.arange(n, dtype=float) + 0.5)
        x = covariate_row(att, deff, scheduled_rounds, is_main_event, is_title_fight)
        x_scaled = (x - np.asarray(self.cov_mean)) / np.asarray(self.cov_std)
        ko = np.exp(self._linear("ko", T, x_scaled))
        sub = np.exp(self._linear("sub", T, x_scaled))
        return ko, sub

    def total_hazards(
        self,
        att: Any,
        deff: Any,
        scheduled_rounds: int,
        is_main_event: bool = False,
        is_title_fight: bool = False,
    ) -> tuple[float, float]:
        """Integrated KO / submission hazard over the whole scheduled fight —
        the direct analogue of `_ko_total_loghaz` / `_sub_total_loghaz`."""
        ko, sub = self.predict_rates(
            att, deff, scheduled_rounds, is_main_event, is_title_fight
        )
        return float(ko.sum()), float(sub.sum())

    # ── persistence ────────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return {
            "coef": self.coef,
            "intercept": self.intercept,
            "cov_mean": self.cov_mean,
            "cov_std": self.cov_std,
            "cov_names": self.cov_names,
            "time_names": self.time_names,
            "meta": self.meta,
        }

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2))

    @classmethod
    def load(cls, path: Path) -> FinishHazardModel:
        return cls(**json.loads(Path(path).read_text()))


# --------------------------------------------------------------------------
# Person-period expansion
# --------------------------------------------------------------------------


@dataclass
class BoutSurvival:
    """One bout reduced to what the likelihood needs."""

    bout_id: str
    event_date: Any
    scheduled_rounds: int
    is_main_event: bool
    is_title_fight: bool
    # Time the bout ended, in seconds. For a finish this is the event time; for
    # a decision it is the full scheduled length (right-censored).
    end_seconds: float
    # 'ko' | 'sub' | None (None = went to the cards / no gradeable finish).
    cause: str | None
    # 0 -> side A did the finishing, 1 -> side B. None when there is no finish.
    finisher_side: int | None
    snap_a: dict[str, Any]
    snap_b: dict[str, Any]
    # 0 / 1 for whichever side won, INCLUDING decisions; None for a draw. Kept
    # separate from finisher_side so the conditional method log-loss can be
    # computed over all three outcome classes — the quantity
    # calibrate_method_mix.py optimizes and the 1.018 constant baseline is
    # measured on. Scoring finishes only would silently change the metric.
    winner_side: int | None = None


def expand_person_periods(
    bouts: list[BoutSurvival], bin_seconds: int = BIN_SECONDS
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Expand to (T, X, exposure, y_ko, y_sub).

    One row per (bout, direction, time bin) while the bout is still live.
    Direction 0 is "A finishes B", direction 1 is "B finishes A": BOTH
    directions of every bout are emitted, which makes the design matrix exactly
    antisymmetric in the fighter slot and removes the scrape's A-side winner
    bias without any hashing or flipping.

    `exposure` is the seconds actually lived inside the bin, so the terminal
    partial bin contributes its true length rather than a full one.
    """
    T_rows: list[np.ndarray] = []
    X_rows: list[np.ndarray] = []
    expo: list[float] = []
    y_ko: list[float] = []
    y_sub: list[float] = []

    for b in bouts:
        cov = [
            covariate_row(b.snap_a, b.snap_b, b.scheduled_rounds,
                          b.is_main_event, b.is_title_fight),
            covariate_row(b.snap_b, b.snap_a, b.scheduled_rounds,
                          b.is_main_event, b.is_title_fight),
        ]
        end = float(b.end_seconds)
        edges = np.arange(0.0, end, float(bin_seconds))
        for start in edges:
            stop = min(start + bin_seconds, end)
            width = stop - start
            if width <= 0:
                continue
            mid = start + width / 2.0
            tb = time_basis(np.array([mid]))[0]
            terminal = stop >= end - 1e-9
            for direction in (0, 1):
                T_rows.append(tb)
                X_rows.append(cov[direction])
                expo.append(width)
                hit = (
                    terminal
                    and b.cause is not None
                    and b.finisher_side == direction
                )
                y_ko.append(1.0 if (hit and b.cause == "ko") else 0.0)
                y_sub.append(1.0 if (hit and b.cause == "sub") else 0.0)

    return (
        np.asarray(T_rows),
        np.asarray(X_rows),
        np.asarray(expo),
        np.asarray(y_ko),
        np.asarray(y_sub),
    )


def survival_loglik(
    model: FinishHazardModel, bouts: list[BoutSurvival]
) -> dict[str, float]:
    """Mean per-bout log-likelihood under the fitted cause-specific hazards.

    L(bout) = sum over both directions of [ -integral(lambda_ko + lambda_sub) ]
              + log lambda_cause(t_event) when the bout ended in a finish.

    This is the honest held-out score for the model as a MODEL: it grades the
    timing and the cause jointly, unlike the marginal-rate checks the MC has
    been tuned against until now.
    """
    total = 0.0
    for b in bouts:
        end = int(round(b.end_seconds))
        ll = 0.0
        rates: list[tuple[np.ndarray, np.ndarray]] = []
        for att, deff in ((b.snap_a, b.snap_b), (b.snap_b, b.snap_a)):
            ko, sub = model.predict_rates(
                att, deff, b.scheduled_rounds, b.is_main_event, b.is_title_fight,
                total_seconds=max(end, 1),
            )
            rates.append((ko, sub))
            ll -= float(ko.sum() + sub.sum())
        if b.cause is not None and b.finisher_side is not None:
            ko, sub = rates[b.finisher_side]
            idx = min(max(end - 1, 0), len(ko) - 1)
            lam = ko[idx] if b.cause == "ko" else sub[idx]
            ll += float(np.log(max(lam, 1e-12)))
        total += ll
    return {"n_bouts": len(bouts), "mean_loglik": total / max(1, len(bouts))}


def integrate_outcomes(lam: dict[str, np.ndarray]) -> dict[str, float]:
    """Exact competing-risks integration of four per-second hazard arrays
    (keys ko_0, sub_0, ko_1, sub_1) into outcome masses. No Monte Carlo noise —
    this is what simulate_bout estimates by sampling 10,000 times, and it lets
    two hazard SPECIFICATIONS be compared without sampling variance in the
    way."""
    total = sum(lam.values())
    # Survival to the START of each second.
    surv = np.exp(-np.concatenate([[0.0], np.cumsum(total)[:-1]]))
    out = {k: float((surv * v).sum()) for k, v in lam.items()}
    out["decision"] = float(np.exp(-total.sum()))
    # Numerical guard: the discretized masses can drift a hair from 1.
    s = sum(out.values())
    if s > 0:
        out = {k: v / s for k, v in out.items()}
    return {
        "ko_a": out["ko_0"], "sub_a": out["sub_0"],
        "ko_b": out["ko_1"], "sub_b": out["sub_1"],
        "decision": out["decision"],
    }


def fitted_hazard_arrays(
    model: FinishHazardModel, b: BoutSurvival
) -> dict[str, np.ndarray]:
    n = b.scheduled_rounds * SECONDS_PER_ROUND
    lam: dict[str, np.ndarray] = {}
    for side, (att, deff) in enumerate(((b.snap_a, b.snap_b), (b.snap_b, b.snap_a))):
        ko, sub = model.predict_rates(
            att, deff, b.scheduled_rounds, b.is_main_event, b.is_title_fight,
            total_seconds=n,
        )
        lam[f"ko_{side}"] = ko
        lam[f"sub_{side}"] = sub
    return lam


def current_mc_hazard_arrays(b: BoutSurvival) -> dict[str, np.ndarray]:
    """The SAME four hazard arrays as `monte_carlo.simulate_bout` builds today,
    from the hand-set constants. Exposed so the fitted model can be graded
    against the incumbent on identical bouts with identical downstream
    arithmetic — the only difference being where the hazards came from."""
    from . import monte_carlo as mc

    n = b.scheduled_rounds * mc.SECONDS_PER_ROUND
    length_bonus = 1.0 + mc.LENGTH_FINISH_BONUS * max(0, b.scheduled_rounds - 3) / 2.0
    H = {
        "ko_0": mc._ko_total_loghaz(b.snap_a, b.snap_b) * length_bonus,
        "sub_0": mc._sub_total_loghaz(b.snap_a, b.snap_b) * length_bonus,
        "ko_1": mc._ko_total_loghaz(b.snap_b, b.snap_a) * length_bonus,
        "sub_1": mc._sub_total_loghaz(b.snap_b, b.snap_a) * length_bonus,
    }
    total_H = sum(H.values())
    cap_H = -np.log(1.0 - mc.FINISH_CAP_MAX)
    if total_H > cap_H and total_H > 0:
        scale = cap_H / total_H
        H = {k: v * scale for k, v in H.items()}
    w_b = mc._timing_weights(mc._power(b.snap_a), n)  # timing of B being finished
    w_a = mc._timing_weights(mc._power(b.snap_b), n)
    return {
        "ko_0": H["ko_0"] * w_b, "sub_0": H["sub_0"] * w_b,
        "ko_1": H["ko_1"] * w_a, "sub_1": H["sub_1"] * w_a,
    }


def outcome_probabilities(
    model: FinishHazardModel, b: BoutSurvival
) -> dict[str, float]:
    """P(ko_a), P(ko_b), P(sub_a), P(sub_b), P(decision) under the fitted
    hazards."""
    return integrate_outcomes(fitted_hazard_arrays(model, b))

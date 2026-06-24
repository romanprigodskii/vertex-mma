"""Monte Carlo round simulator.

For each upcoming bout we simulate N=10,000 fights using per-minute
hazard rates derived from each fighter's historical stats (already
materialized in the FighterHistory snapshots from export.py). The
output is a distribution of (winner, method, round_finished) we can
join with the LightGBM prob for a richer "how" panel.

Modeling choices, all kept deliberately simple in Phase 3:

* Time is sliced into 1-second ticks; each tick rolls a finish chance.
* KO hazard per second for fighter X = base + α × X.knockdowns_per_fight
  scaled into a per-second rate, modulated by opponent's prior_losses_ko
  rate (chin proxy). Same shape for SUB hazard using sub_per15 +
  opponent's prior_losses_sub.
* No-finish ticks accumulate "round momentum" — at the bell, the
  fighter with more accumulated control time + sig strikes is the
  decision favorite (Bradley-Terry-ish softmax with temperature).
* When a fighter has no prior bouts (rare — both must have ≥1 by the
  predict.py filter, but stats can still be partial), the missing stat
  defaults to roster averages.
* Calibration guards (constants below): the offense/defense lift multipliers
  are CLAMPED, small-sample career rates are SHRUNK toward roster means, and
  the final KO/sub/decision mix is ANCHORED toward real UFC base rates. These
  counter the per-second hazard compounding finishes toward ~100% over 3-5
  rounds; without them a puncher-vs-weak-chin 5-rounder reads as a near-certain
  KO and decisions collapse to ~0.

Phase 4+ ideas (NOT in this implementation): per-round fatigue decay (the real
root fix — lower the base hazard + cap per-fight finish prob), takedown →
ground positions, strike location heatmaps.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

# Roster-mean fallbacks for missing per-fighter stats. Loosely calibrated
# against the dataset; precise values matter less than having a sensible
# floor instead of NaN propagation.
ROSTER_DEFAULTS = {
    "slpm": 3.5,
    "sapm": 3.5,
    "kd_per_fight": 0.25,
    "sub_per15": 0.5,
    "td_per15": 1.2,
    "td_def": 0.55,
    "control_per_min": 0.15,
    "losses_ko_rate": 0.15,
    "losses_sub_rate": 0.05,
    "finish_rate_for": 0.4,
}

# Base per-second hazards (a "neutral" UFC bout has ~25 % chance of
# ending by KO/TKO and ~10 % by sub over a ~14 min sample). These
# numbers are tuned so that with average inputs the simulator emits
# UFC-realistic finish-rate splits before any fighter-specific lift.
BASE_KO_HAZARD_PER_SEC = 0.00040
BASE_SUB_HAZARD_PER_SEC = 0.00018
# Strength multipliers — how much a fighter's own offensive stat or
# the opponent's vulnerability moves the hazard.
KO_OFFENSE_WEIGHT = 0.6
KO_DEFENSE_WEIGHT = 1.0
SUB_OFFENSE_WEIGHT = 0.8
SUB_DEFENSE_WEIGHT = 1.0

# Decision-time scoring softness.
DECISION_TEMPERATURE = 0.45

# --- Calibration guards (fix for KO over-prediction) -------------------------
# 1. Clamp the offense/defense lift multipliers. Raw small-sample career ratios
#    (e.g. a fighter whose single career loss was a KO -> losses_ko_rate = 1.0)
#    otherwise hand the opponent a ~6x "glass chin" multiplier and saturate
#    P(KO) -> 1.0. Clamp keeps any single lift in a sane band.
LIFT_MIN, LIFT_MAX = 0.4, 2.5
# 2. Bayesian shrinkage: blend a fighter's raw finish/durability rate toward the
#    neutral anchor with this many pseudo-observations, so tiny denominators
#    (1-of-1 rates) aren't taken at face value. rate' = (rate*n + anchor*k)/(n+k).
SHRINK_PSEUDO_COUNTS = 4.0
# 3. Anchor the simulated method mix toward real UFC base rates. The per-second
#    hazard compounds finishes over 3-5 rounds, so the raw split skews KO-heavy
#    and decision-light. We blend each side's CONDITIONAL (method | this fighter
#    wins) mix toward the base with weight LAMBDA, which PRESERVES each fighter's
#    win probability and only reshapes how they win. LAMBDA is the tuning knob:
#    0 = raw simulator, 1 = pure base rate. The proper fix (lower the base
#    hazard + per-fight finish cap + fatigue decay) is deferred; this anchor is
#    the low-risk near-term correction.
METHOD_BASE_KO = 0.33
METHOD_BASE_SUB = 0.17
METHOD_BASE_DEC = 0.50
METHOD_ANCHOR_LAMBDA = 0.6

# Neutral anchors used by the lift formulas (lift = 1.0 at these values).
_KO_OFF_ANCHOR = 0.35
_KO_DEF_ANCHOR = 0.15
_SUB_OFF_ANCHOR = 1.0
_SUB_DEF_ANCHOR = 0.05


def _clamp_lift(x: float) -> float:
    return min(LIFT_MAX, max(LIFT_MIN, x))


def _shrink(rate: float, n: int, anchor: float, k: float = SHRINK_PSEUDO_COUNTS) -> float:
    """Blend an observed `rate` (from `n` observations) toward `anchor` with
    `k` pseudo-observations. Small n -> close to anchor; large n -> close to
    rate."""
    n = max(0, int(n))
    return (rate * n + anchor * k) / (n + k)


@dataclass
class FighterMC:
    """One side's per-bout inputs for the simulator. Pulled directly from
    the snapshot built in export.FighterHistory.snapshot()."""

    slpm: float
    sapm: float
    kd_per_fight: float
    sub_per15: float
    td_per15: float
    td_def: float
    control_per_min: float
    losses_ko_rate: float
    losses_sub_rate: float
    finish_rate_for: float

    @classmethod
    def from_snapshot(cls, snap: dict[str, Any]) -> "FighterMC":
        def g(key: str, default: float) -> float:
            v = snap.get(key)
            if v is None:
                return default
            try:
                fv = float(v)
            except (TypeError, ValueError):
                return default
            if not np.isfinite(fv):
                return default
            return fv

        prior_bouts = max(1, int(snap.get("prior_bouts") or 1))
        prior_wins = max(0, int(snap.get("prior_wins") or 0))
        prior_losses = max(0, int(snap.get("prior_losses") or 0))
        losses_ko = max(0, int(snap.get("prior_losses_ko") or 0))
        losses_sub = max(0, int(snap.get("prior_losses_sub") or 0))
        wins_ko = max(0, int(snap.get("prior_wins_ko") or 0))
        wins_sub = max(0, int(snap.get("prior_wins_sub") or 0))
        finish_rate_for_raw = (wins_ko + wins_sub) / prior_wins if prior_wins else ROSTER_DEFAULTS["finish_rate_for"]
        losses_ko_rate_raw = losses_ko / prior_losses if prior_losses else ROSTER_DEFAULTS["losses_ko_rate"]
        losses_sub_rate_raw = losses_sub / prior_losses if prior_losses else ROSTER_DEFAULTS["losses_sub_rate"]
        # Shrink each rate toward its neutral anchor by sample size, so a tiny
        # denominator (e.g. a 1-of-1 KO loss) doesn't become a hard signal that
        # the lift multipliers then blow up.
        finish_rate_for = _shrink(finish_rate_for_raw, prior_wins, ROSTER_DEFAULTS["finish_rate_for"])
        losses_ko_rate = _shrink(losses_ko_rate_raw, prior_losses, _KO_DEF_ANCHOR)
        losses_sub_rate = _shrink(losses_sub_rate_raw, prior_losses, _SUB_DEF_ANCHOR)

        return cls(
            slpm=g("slpm", ROSTER_DEFAULTS["slpm"]),
            sapm=g("sapm", ROSTER_DEFAULTS["sapm"]),
            kd_per_fight=_shrink(g("kd_per_fight", ROSTER_DEFAULTS["kd_per_fight"]), prior_bouts, _KO_OFF_ANCHOR),
            sub_per15=_shrink(g("sub_per15", ROSTER_DEFAULTS["sub_per15"]), prior_bouts, _SUB_OFF_ANCHOR),
            td_per15=g("td_per15", ROSTER_DEFAULTS["td_per15"]),
            td_def=g("td_def", ROSTER_DEFAULTS["td_def"]),
            control_per_min=g("control_per_min", ROSTER_DEFAULTS["control_per_min"]),
            losses_ko_rate=losses_ko_rate,
            losses_sub_rate=losses_sub_rate,
            finish_rate_for=finish_rate_for,
        )


def _ko_hazard(att: FighterMC, deff: FighterMC) -> float:
    offense_lift = _clamp_lift(1.0 + KO_OFFENSE_WEIGHT * (att.kd_per_fight / _KO_OFF_ANCHOR - 1.0))
    defense_lift = _clamp_lift(1.0 + KO_DEFENSE_WEIGHT * (deff.losses_ko_rate / _KO_DEF_ANCHOR - 1.0))
    return BASE_KO_HAZARD_PER_SEC * offense_lift * defense_lift


def _sub_hazard(att: FighterMC, deff: FighterMC) -> float:
    # sub_per15 is per 15 minutes of fight time → per second ≈ /900,
    # but the absolute base hazard already covers most of the rate.
    offense_lift = _clamp_lift(1.0 + SUB_OFFENSE_WEIGHT * (att.sub_per15 / _SUB_OFF_ANCHOR - 1.0))
    defense_lift = _clamp_lift(1.0 + SUB_DEFENSE_WEIGHT * (deff.losses_sub_rate / _SUB_DEF_ANCHOR - 1.0))
    return BASE_SUB_HAZARD_PER_SEC * offense_lift * defense_lift


def _decision_logit(a: FighterMC, b: FighterMC) -> float:
    """Bradley-Terry-ish logit of A winning the decision. Uses the same
    inputs that real-life judges weight: more sig strikes per minute,
    more control time, fewer absorbed strikes."""
    delta = (
        (a.slpm - b.slpm) * 0.18
        + (b.sapm - a.sapm) * 0.10
        + (a.control_per_min - b.control_per_min) * 0.8
        + (a.td_per15 - b.td_per15) * 0.08
    )
    return delta


@dataclass
class MCResult:
    n_simulations: int
    winner_prob_a: float
    winner_prob_b: float
    prob_ko_a: float
    prob_ko_b: float
    prob_sub_a: float
    prob_sub_b: float
    prob_decision_a: float
    prob_decision_b: float
    prob_finish_per_round: dict[int, float]
    avg_finish_seconds: float | None
    distribution: dict[str, Any]


def _anchor_methods(
    ko_a: float, ko_b: float, sub_a: float, sub_b: float, dec_a: float, dec_b: float
) -> tuple[float, float, float, float, float, float]:
    """Blend each fighter's CONDITIONAL method mix (method given THIS fighter
    wins) toward the UFC base rate (METHOD_BASE_*) with weight
    METHOD_ANCHOR_LAMBDA. Preserves P(each fighter wins) exactly — only how
    they win is reshaped. Returns (ko_a, ko_b, sub_a, sub_b, dec_a, dec_b)."""
    lam = METHOD_ANCHOR_LAMBDA

    def anchor_side(ko: float, sub: float, dec: float) -> tuple[float, float, float]:
        win = ko + sub + dec
        if win <= 0.0:
            return ko, sub, dec
        nk = (1.0 - lam) * (ko / win) + lam * METHOD_BASE_KO
        ns = (1.0 - lam) * (sub / win) + lam * METHOD_BASE_SUB
        nd = (1.0 - lam) * (dec / win) + lam * METHOD_BASE_DEC
        norm = nk + ns + nd  # == 1.0 by construction; guard against fp drift
        return nk / norm * win, ns / norm * win, nd / norm * win

    ka, sa, da = anchor_side(ko_a, sub_a, dec_a)
    kb, sb, db = anchor_side(ko_b, sub_b, dec_b)
    return ka, kb, sa, sb, da, db


def simulate_bout(
    a: FighterMC,
    b: FighterMC,
    scheduled_rounds: int,
    n_simulations: int = 10_000,
    seed: int | None = None,
) -> MCResult:
    rng = np.random.default_rng(seed)

    ko_a = _ko_hazard(a, b)
    ko_b = _ko_hazard(b, a)
    sub_a = _sub_hazard(a, b)
    sub_b = _sub_hazard(b, a)

    seconds_per_round = 300
    total_seconds = scheduled_rounds * seconds_per_round

    # Per-second per-event probabilities are tiny; we vectorize across
    # simulations: each simulation maintains a "remaining" mask. At each
    # tick draw 4 Bernoullis (KO_a, KO_b, SUB_a, SUB_b). First true →
    # finish event for that sim.
    remaining = np.ones(n_simulations, dtype=bool)
    finish_method = np.full(n_simulations, "", dtype=object)
    finish_seconds = np.full(n_simulations, -1, dtype=np.int32)
    finish_round = np.full(n_simulations, -1, dtype=np.int32)

    for t in range(total_seconds):
        if not remaining.any():
            break
        active_idx = np.where(remaining)[0]
        # Draw probabilities only for still-active sims.
        u = rng.random((4, active_idx.size))
        # Order matters slightly when multiple events fire same tick;
        # apply KO_a → KO_b → SUB_a → SUB_b with tie-break first-true wins.
        hits_ko_a = u[0] < ko_a
        hits_ko_b = u[1] < ko_b
        hits_sub_a = u[2] < sub_a
        hits_sub_b = u[3] < sub_b
        any_hit = hits_ko_a | hits_ko_b | hits_sub_a | hits_sub_b
        if not any_hit.any():
            continue
        # Determine which method per finishing sim. Ordered preference if
        # multiple fire in the same tick — extremely rare and impact is
        # negligible vs simulation variance.
        finishing_local = np.where(any_hit)[0]
        for local in finishing_local:
            sim_i = active_idx[local]
            if hits_ko_a[local]:
                m = "ko_a"
            elif hits_ko_b[local]:
                m = "ko_b"
            elif hits_sub_a[local]:
                m = "sub_a"
            else:
                m = "sub_b"
            finish_method[sim_i] = m
            finish_seconds[sim_i] = t + 1
            finish_round[sim_i] = (t // seconds_per_round) + 1
            remaining[sim_i] = False

    # Simulations that survived to the bell → decision. Stochastic
    # because real judging is noisy.
    survivors = np.where(remaining)[0]
    if survivors.size > 0:
        logit = _decision_logit(a, b)
        # Bradley-Terry: P(A wins) = sigmoid(logit / temperature). Per-sim
        # noise added so each survivor is an independent coin flip with
        # the same mean.
        p_a_wins = 1.0 / (1.0 + np.exp(-(logit / DECISION_TEMPERATURE)))
        draws = rng.random(survivors.size)
        for local, sim_i in enumerate(survivors):
            finish_method[sim_i] = "dec_a" if draws[local] < p_a_wins else "dec_b"
            finish_seconds[sim_i] = total_seconds
            finish_round[sim_i] = scheduled_rounds

    methods, counts = np.unique(finish_method, return_counts=True)
    method_counts: dict[str, int] = dict(zip(methods.tolist(), counts.tolist(), strict=False))

    def share(key: str) -> float:
        return method_counts.get(key, 0) / n_simulations

    raw_ko_a = share("ko_a")
    raw_ko_b = share("ko_b")
    raw_sub_a = share("sub_a")
    raw_sub_b = share("sub_b")
    raw_dec_a = share("dec_a")
    raw_dec_b = share("dec_b")
    # Anchor the method mix toward UFC base rates (preserves each win prob).
    prob_ko_a, prob_ko_b, prob_sub_a, prob_sub_b, prob_dec_a, prob_dec_b = _anchor_methods(
        raw_ko_a, raw_ko_b, raw_sub_a, raw_sub_b, raw_dec_a, raw_dec_b
    )
    win_a = prob_ko_a + prob_sub_a + prob_dec_a
    win_b = prob_ko_b + prob_sub_b + prob_dec_b

    # Per-(fighter, method) scale factors so the per-round breakdown below stays
    # consistent with the anchored summary (each finish lives in one round, so
    # scaling each round's count by the same factor keeps the sums equal to the
    # anchored totals).
    def _mscale(anchored: float, raw: float) -> float:
        return anchored / raw if raw > 0 else 0.0

    mscale = {
        "ko_a": _mscale(prob_ko_a, raw_ko_a),
        "ko_b": _mscale(prob_ko_b, raw_ko_b),
        "sub_a": _mscale(prob_sub_a, raw_sub_a),
        "sub_b": _mscale(prob_sub_b, raw_sub_b),
    }

    # Per-round finish probability (any method, either fighter).
    finished_mask = finish_round > 0
    avg_finish: float | None = None
    if finished_mask.any():
        early = finish_seconds[finished_mask & (finish_method != "dec_a") & (finish_method != "dec_b")]
        if early.size > 0:
            avg_finish = float(np.mean(early))

    # Per-round finish probability (any method, either fighter), weighted by
    # the per-method anchor scale so it matches the anchored summary totals.
    prob_finish_per_round: dict[int, float] = {}
    for r in range(1, scheduled_rounds + 1):
        m_in_r = finish_method[finish_round == r]
        scaled = sum(float(np.sum(m_in_r == key)) * mscale[key] for key in mscale)
        prob_finish_per_round[r] = scaled / n_simulations

    # JSONB payload — per-round per-method breakdown for any downstream
    # consumer who wants finer detail than the summary columns. Scaled to the
    # anchored summary so the rounds sum back to prob_ko_*/prob_sub_*.
    by_round: dict[str, Any] = {}
    for r in range(1, scheduled_rounds + 1):
        m_in_r = finish_method[finish_round == r]
        by_round[str(r)] = {
            key: float(np.sum(m_in_r == key)) * mscale[key] / n_simulations for key in mscale
        }
    distribution = {
        "n_simulations": n_simulations,
        "winner_prob_a": float(win_a),
        "by_round": by_round,
        "decision_a": float(prob_dec_a),
        "decision_b": float(prob_dec_b),
        "avg_finish_seconds": avg_finish,
    }

    return MCResult(
        n_simulations=n_simulations,
        winner_prob_a=float(win_a),
        winner_prob_b=float(win_b),
        prob_ko_a=prob_ko_a,
        prob_ko_b=prob_ko_b,
        prob_sub_a=prob_sub_a,
        prob_sub_b=prob_sub_b,
        prob_decision_a=prob_dec_a,
        prob_decision_b=prob_dec_b,
        prob_finish_per_round=prob_finish_per_round,
        avg_finish_seconds=avg_finish,
        distribution=distribution,
    )

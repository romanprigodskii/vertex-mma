"""Monte Carlo round simulator.

For each upcoming bout we simulate N=10,000 fights and read off a distribution
of (winner, method, round_finished) to join with the LightGBM winner prob for a
richer "how" panel.

Finish model (Phase 6 redesign — replaces the old memoryless per-second
Bernoulli, which decayed geometrically from the opening bell and let longer
bouts rack up finishes purely on tick count):

* Finishes are a time-INHOMOGENEOUS Poisson process. The TOTAL finish
  log-hazard over a bout, H, is set PER FIGHTER-PAIR and is independent of the
  number of scheduled rounds — so P(finish) ≈ 1 − exp(−H) no longer balloons for
  5-round bouts (a small, non-proportional championship-round bonus is the only
  length effect). This is the core fix for "5-rounders over-finish 3-rounders".
* That total hazard is distributed across the fight by an ACCUMULATED-DAMAGE
  timing shape: per-second finish weight rises as (floor + τ^γ) with τ the
  fraction of the fight elapsed, so finishes cluster in the later rounds as
  damage piles up, instead of front-loading. A within-round ramp adds the
  end-of-round push, and a power tilt shifts a heavy hitter's finishes earlier
  (flash-KO capable) vs a point-fighter's later.
* A per-fight finish CAP bounds P(any finish) so a puncher-vs-weak-chin bout
  can't asymptote toward a near-certain finish.
* Career rates are still SHRUNK toward roster means (tiny denominators), lift
  multipliers CLAMPED, and the final KO/sub/decision mix lightly ANCHORED toward
  real UFC base rates — but the per-fight scales now do most of the calibration,
  so the anchor is only a tail safety net.

Still simplified vs reality (noted, not modelled): explicit per-strike damage
state, takedown→ground position chains, true sub-from-grappling timing distinct
from KO timing. The hazard shape is a deterministic function of the fighters
(fast, calibratable), not a per-simulation stochastic damage walk.
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

SECONDS_PER_ROUND = 300

# === Per-fight finish log-hazards ============================================
# Total per-fight KO / submission log-hazard for an AVERAGE matchup (all lifts =
# 1). P(that finish) ≈ 1 − exp(−H). Tuned so a realistic slate averages roughly
# 33% KO / 17% sub / 50% decision while preserving the fighter-specific spread
# (a slugfest still reads well above 33% KO, a grappling match above 17% sub).
KO_TOTAL_SCALE = 0.185
SUB_TOTAL_SCALE = 0.140

# Offense/defense lifts (same shape + clamp as the old per-second model) scale
# H per matchup. Raw small-sample ratios are clamped so a 1-of-1 "glass chin"
# can't hand the opponent a ~6× multiplier and saturate P(KO).
KO_OFFENSE_WEIGHT = 0.6
KO_DEFENSE_WEIGHT = 1.0
SUB_OFFENSE_WEIGHT = 0.8
SUB_DEFENSE_WEIGHT = 1.0
LIFT_MIN, LIFT_MAX = 0.4, 2.5

# Per-fight finish CAP: no bout may exceed this P(any finish).
FINISH_CAP_MAX = 0.90

# Modest, NON-proportional bonus for the two extra championship rounds: a
# 5-round bout finishes a bit more often than a 3-round one (more time to break
# a hurt fighter), but nowhere near the tick-count blowup of the old model.
# Applied as ×(1 + bonus) interpolated over 3r→5r.
LENGTH_FINISH_BONUS = 0.12

# === Accumulated-damage timing shape =========================================
# Per-second finish weight at fight-fraction τ rises as (DAMAGE_FLOOR + τ^γ):
# the floor keeps early/flash finishes possible; τ^γ clusters finishes late as
# damage accumulates.
DAMAGE_GAMMA = 1.6  # global lateness; >1 pushes finishes toward later rounds
DAMAGE_FLOOR = 0.12  # floor so an early finish is never impossible
GAMMA_MIN, GAMMA_MAX = 0.9, 2.8
# Within-round ramp: hazard rises through each round (fatigue / pre-bell push),
# partially resetting between rounds.
ROUND_RAMP = 0.55
# Power tilt: a heavy hitter's finishes shift earlier, a point-fighter's later.
# Scales γ by the attacker's KO power (γ_eff = γ / power).
POWER_TILT = 0.35
POWER_MIN, POWER_MAX = 0.6, 1.6

# Decision-time scoring softness.
DECISION_TEMPERATURE = 0.45

# === Calibration guards ======================================================
# Bayesian shrinkage: blend a fighter's raw finish/durability rate toward the
# neutral anchor with this many pseudo-observations (tiny denominators aren't
# taken at face value). rate' = (rate*n + anchor*k)/(n+k).
SHRINK_PSEUDO_COUNTS = 4.0

# Method-mix anchor toward UFC base rates — preserves each fighter's win
# prob, only reshapes how they win (0 = raw, 1 = pure base).
#
# Calibrated 2026-07-10 (scripts/calibrate_method_mix.py, 1,646 bouts
# 2021-01-01..2024-12-31, strictly pre-test): the raw per-fight conditional
# mix "method | this fighter wins" was far too finish-heavy — cond
# log-loss 1.38 vs 1.018 for a CONSTANT base-rate predictor. The lambda
# sweep has an interior optimum at 0.80 (1.0119): the per-fight mix
# carries real but SMALL signal (~20% weight), the rest is noise the old
# 0.08 let straight through — that's why the method-market backtest
# (eval_method_market.py) saw KO predicted 38.7% vs 31.0% actual. Hazard
# scales were re-validated in the same sweep: (1.0, 1.0) multipliers stay
# best for the marginals, do NOT compensate here. Base rates below are the
# measured modern-era mix (31.2/18.2/50.6), not the folklore 33/17/50.
METHOD_BASE_KO = 0.31
METHOD_BASE_SUB = 0.18
METHOD_BASE_DEC = 0.51
METHOD_ANCHOR_LAMBDA = 0.80

# Neutral anchors used by the lift formulas (lift = 1.0 at these values).
_KO_OFF_ANCHOR = 0.35
_KO_DEF_ANCHOR = 0.15
_SUB_OFF_ANCHOR = 1.0
_SUB_DEF_ANCHOR = 0.05


def _clamp(x: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, x))


def _clamp_lift(x: float) -> float:
    return _clamp(x, LIFT_MIN, LIFT_MAX)


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


def _ko_total_loghaz(att: FighterMC, deff: FighterMC) -> float:
    """Total per-fight KO log-hazard for `att` finishing `deff` (lift = 1 at the
    neutral anchors). P(this KO) ≈ 1 − exp(−H) before the other methods compete."""
    offense_lift = _clamp_lift(1.0 + KO_OFFENSE_WEIGHT * (att.kd_per_fight / _KO_OFF_ANCHOR - 1.0))
    defense_lift = _clamp_lift(1.0 + KO_DEFENSE_WEIGHT * (deff.losses_ko_rate / _KO_DEF_ANCHOR - 1.0))
    return KO_TOTAL_SCALE * offense_lift * defense_lift


def _sub_total_loghaz(att: FighterMC, deff: FighterMC) -> float:
    """Total per-fight submission log-hazard for `att` finishing `deff`."""
    offense_lift = _clamp_lift(1.0 + SUB_OFFENSE_WEIGHT * (att.sub_per15 / _SUB_OFF_ANCHOR - 1.0))
    defense_lift = _clamp_lift(1.0 + SUB_DEFENSE_WEIGHT * (deff.losses_sub_rate / _SUB_DEF_ANCHOR - 1.0))
    return SUB_TOTAL_SCALE * offense_lift * defense_lift


def _power(att: FighterMC) -> float:
    """Finishing-power factor for the timing tilt: >1 for heavy hitters (their
    finishes shift earlier), <1 for point-fighters (later)."""
    return _clamp(1.0 + POWER_TILT * (att.kd_per_fight / _KO_OFF_ANCHOR - 1.0), POWER_MIN, POWER_MAX)


def _timing_weights(att_power: float, total_seconds: int) -> np.ndarray:
    """Per-second finish weights (sum to 1) shaping WHEN finishes land. Rises as
    (DAMAGE_FLOOR + τ^γ) across the fight (accumulated damage), times a
    within-round ramp. γ is shifted by the attacker's power so punchers finish
    a touch earlier. Normalized so the total hazard is unchanged (length-safe)."""
    t = np.arange(total_seconds)
    tau = t / max(total_seconds - 1, 1)
    round_frac = (t % SECONDS_PER_ROUND) / SECONDS_PER_ROUND
    gamma = _clamp(DAMAGE_GAMMA / att_power, GAMMA_MIN, GAMMA_MAX)
    shape = (DAMAGE_FLOOR + tau**gamma) * (1.0 + ROUND_RAMP * round_frac)
    s = float(shape.sum())
    if s <= 0:
        return np.full(total_seconds, 1.0 / max(total_seconds, 1))
    return shape / s


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
    total_seconds = scheduled_rounds * SECONDS_PER_ROUND

    # Per-fight TOTAL finish log-hazards — independent of the number of rounds
    # (the fix for length bias). One modest non-proportional championship-round
    # bonus is the only length effect.
    length_bonus = 1.0 + LENGTH_FINISH_BONUS * max(0, scheduled_rounds - 3) / 2.0
    H_ko_a = _ko_total_loghaz(a, b) * length_bonus
    H_sub_a = _sub_total_loghaz(a, b) * length_bonus
    H_ko_b = _ko_total_loghaz(b, a) * length_bonus
    H_sub_b = _sub_total_loghaz(b, a) * length_bonus

    # Per-fight finish cap: bound P(any finish) so an extreme matchup can't
    # asymptote toward a certain finish.
    H_total = H_ko_a + H_sub_a + H_ko_b + H_sub_b
    cap_H = -np.log(1.0 - FINISH_CAP_MAX)
    if H_total > cap_H and H_total > 0:
        s = cap_H / H_total
        H_ko_a *= s
        H_sub_a *= s
        H_ko_b *= s
        H_sub_b *= s

    # Accumulated-damage timing: A finishing B is shaped by A's power (how fast A
    # breaks B down), and vice versa. Each schedule sums to 1, so the totals
    # above (and thus P(finish)) are unchanged — only the WHEN moves.
    w_b = _timing_weights(_power(a), total_seconds)  # timing of B being finished
    w_a = _timing_weights(_power(b), total_seconds)  # timing of A being finished
    haz_ko_a = H_ko_a * w_b
    haz_sub_a = H_sub_a * w_b
    haz_ko_b = H_ko_b * w_a
    haz_sub_b = H_sub_b * w_a

    # Vectorize across simulations: each sim keeps a "remaining" mask. At each
    # tick draw 4 Bernoullis (KO_a, KO_b, SUB_a, SUB_b) at that tick's hazard.
    # First true → finish event for that sim.
    remaining = np.ones(n_simulations, dtype=bool)
    finish_method = np.full(n_simulations, "", dtype=object)
    finish_seconds = np.full(n_simulations, -1, dtype=np.int32)
    finish_round = np.full(n_simulations, -1, dtype=np.int32)

    for t in range(total_seconds):
        if not remaining.any():
            break
        active_idx = np.where(remaining)[0]
        # Draw probabilities only for still-active sims, vs this tick's hazards.
        u = rng.random((4, active_idx.size))
        # Order matters slightly when multiple events fire same tick;
        # apply KO_a → KO_b → SUB_a → SUB_b with tie-break first-true wins.
        hits_ko_a = u[0] < haz_ko_a[t]
        hits_ko_b = u[1] < haz_ko_b[t]
        hits_sub_a = u[2] < haz_sub_a[t]
        hits_sub_b = u[3] < haz_sub_b[t]
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
            finish_round[sim_i] = (t // SECONDS_PER_ROUND) + 1
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

    # Expected finish time GIVEN a finish, weighted by the ANCHORED per-method
    # probabilities. A plain mean over finishing sims ignores the anchor's
    # method reweighting (KO finishes earlier than subs, so shifting the KO/sub
    # mix moves the expected time); using per-method means keeps it consistent
    # with the anchored summary and avoids any single-sim blow-up.
    avg_finish: float | None = None
    _anchored_method = {
        "ko_a": prob_ko_a,
        "ko_b": prob_ko_b,
        "sub_a": prob_sub_a,
        "sub_b": prob_sub_b,
    }
    _num = 0.0
    _den = 0.0
    for _key, _p in _anchored_method.items():
        _secs = finish_seconds[finish_method == _key]
        if _secs.size > 0 and _p > 0:
            _num += _p * float(np.mean(_secs))
            _den += _p
    if _den > 0:
        avg_finish = _num / _den

    # Per-round breakdown: distribute each method's ANCHORED total across rounds
    # by that method's round SHARE (shares sum to 1), so Σ_rounds equals the
    # anchored summary total EXACTLY. The old code multiplied raw per-round
    # counts by anchored/raw, which lost mass when raw==0 (anchor invented
    # finishes the rounds couldn't represent) and blew up a single sim ~120×
    # when a method was rare — so the rounds didn't sum back to prob_ko/prob_sub
    # despite the docstring's claim. When a method has too few raw sims to
    # estimate its own timing, fall back to the POOLED finish-round timing.
    MIN_METHOD_SAMPLES = 25
    anchored_totals = {
        "ko_a": prob_ko_a,
        "ko_b": prob_ko_b,
        "sub_a": prob_sub_a,
        "sub_b": prob_sub_b,
    }
    rounds_range = list(range(1, scheduled_rounds + 1))

    def _round_share(rounds_arr: np.ndarray) -> dict[int, float]:
        if rounds_arr.size == 0:
            return {r: 1.0 / len(rounds_range) for r in rounds_range}
        return {r: float(np.sum(rounds_arr == r)) / rounds_arr.size for r in rounds_range}

    pooled_share = _round_share(
        finish_round[(finish_method != "dec_a") & (finish_method != "dec_b") & (finish_round > 0)]
    )
    method_share: dict[str, dict[int, float]] = {}
    for key in anchored_totals:
        rk = finish_round[finish_method == key]
        method_share[key] = _round_share(rk) if rk.size >= MIN_METHOD_SAMPLES else pooled_share

    by_round: dict[str, Any] = {
        str(r): {key: anchored_totals[key] * method_share[key][r] for key in anchored_totals}
        for r in rounds_range
    }
    prob_finish_per_round: dict[int, float] = {
        r: sum(by_round[str(r)][key] for key in anchored_totals) for r in rounds_range
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

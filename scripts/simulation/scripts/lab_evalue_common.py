"""E-value machinery for the model-vs-market audit.

The lab this builds on (`lab_edge_segments.py`, docs/edge_segments.md) asked
84 pre-registered questions of 1,787 bouts and answered them with paired
log-loss, cluster-robust standard errors and Benjamini-Hochberg. Its own §0
reports what that instrument can see: 10-15 % power against a 3 pp edge,
*0-1 % once BH multiplicity is charged*, and ~89,900 bouts needed to resolve
the effect sizes actually at stake.

This module re-asks the same questions in the currency the setting is
already denominated in.

WHY THE SETTING IS SPECIAL. The e-value literature motivates itself with a
gambler betting against a null. Here the gambler is not a metaphor: the null
hypothesis is a price posted by a bookmaker, the bet is a bet, and the
wealth process IS the e-process. Two consequences that a simulation cannot
reproduce:

  * the null is supplied ADVERSARIALLY by a party with money at risk, rather
    than assumed; and
  * the bettor's stake is PREDICTABLE by construction — the model
    probability comes from a walk-forward fit that saw only bouts strictly
    before the origin, and the closing line is posted before the fight. No
    care is needed to enforce predictability; the calendar enforces it.

THE CONSTRUCTION. For a bout with de-vigged closing probability q on side A
and outcome y in {0,1}, and a predictable stake lambda,

    M = 1 + lambda * (y - q),        lambda in (-1/(1-q), 1/q)

has E[M] = 1 under H0: "q is the true conditional probability". The product
over a segment's bouts, taken in calendar order, is a non-negative test
martingale: its terminal value is an e-value, and by Ville's inequality its
running maximum is anytime-valid.

The growth-rate optimal (GRO / Kelly) stake under the alternative "the
model's probability p is the truth" is available in closed form,

    lambda* = (p - q) / (q * (1 - q))

i.e. the model's edge deflated by the market's own variance. Betting a
fixed fraction of it is standard fractional Kelly; betting a fraction
learned from the past only is a predictable plug-in. Both are implemented,
because the model is known to be under-dispersed (docs/edge_segments.md §6)
and full Kelly on a miscalibrated forecaster is a way to lose a test that a
better-sized bet would have won.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

EPS = 1e-12


# -- stakes ------------------------------------------------------------


def kelly_lambda(p: np.ndarray, q: np.ndarray) -> np.ndarray:
    """GRO stake against the market null under the model's alternative."""
    q = np.clip(np.asarray(q, dtype=float), 1e-6, 1 - 1e-6)
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    return (p - q) / (q * (1.0 - q))


def clip_lambda(lam: np.ndarray, q: np.ndarray, max_risk: float = 0.5) -> np.ndarray:
    """Keep the worst-case loss on any single bout below `max_risk` of wealth.

    The admissible set is the open interval (-1/(1-q), 1/q); the endpoints
    stake the whole bankroll and make the log-wealth process explode on one
    upset. Clipping is a restriction of the stake, not of the null, so
    validity is untouched — a predictable lambda inside the admissible range
    is all the martingale property needs.
    """
    q = np.clip(np.asarray(q, dtype=float), 1e-6, 1 - 1e-6)
    hi = max_risk / q                 # loses max_risk of wealth when y = 0
    lo = -max_risk / (1.0 - q)        # loses max_risk of wealth when y = 1
    return np.clip(np.asarray(lam, dtype=float), lo, hi)


def wealth_increments(
    p: np.ndarray, q: np.ndarray, y: np.ndarray, *, frac: float = 0.5,
    max_risk: float = 0.5,
) -> np.ndarray:
    """Per-bout martingale increments M_t for fractional-Kelly stakes."""
    lam = clip_lambda(frac * kelly_lambda(p, q), q, max_risk)
    y = np.asarray(y, dtype=float)
    q = np.clip(np.asarray(q, dtype=float), 1e-6, 1 - 1e-6)
    return 1.0 + lam * (y - q)


def adaptive_increments(
    p: np.ndarray, q: np.ndarray, y: np.ndarray, *, max_risk: float = 0.5,
    grid: np.ndarray | None = None, warmup: int = 25,
) -> tuple[np.ndarray, np.ndarray]:
    """Predictable plug-in: learn HOW MUCH of the model's edge to bet.

    At bout t the multiplier c_t is the value on `grid` that would have
    maximised realised log-wealth over bouts 1..t-1 — a one-dimensional
    aGRAPA-style plug-in. It uses no information from bout t, so the
    resulting process is still a test martingale, and it lets the data say
    what the docstring above only asserts: that full Kelly is too much bet
    for this forecaster.

    Returns (increments, c_t actually used).
    """
    if grid is None:
        grid = np.linspace(0.0, 1.0, 21)
    n = len(y)
    lam_full = kelly_lambda(p, q)
    y = np.asarray(y, dtype=float)
    qc = np.clip(np.asarray(q, dtype=float), 1e-6, 1 - 1e-6)
    # log-increment of every grid point on every bout, computed once
    logs = np.empty((n, len(grid)))
    for j, c in enumerate(grid):
        lam = clip_lambda(c * lam_full, qc, max_risk)
        logs[:, j] = np.log(np.maximum(1.0 + lam * (y - qc), EPS))
    cum = np.cumsum(logs, axis=0)
    used = np.empty(n)
    inc = np.empty(n)
    for t in range(n):
        if t < warmup:
            c = 0.5
        else:
            c = float(grid[int(np.argmax(cum[t - 1]))])
        used[t] = c
        lam = clip_lambda(c * lam_full[t], qc[t], max_risk)
        inc[t] = 1.0 + lam * (y[t] - qc[t])
    return inc, used


def vigged_increments(
    p: np.ndarray, q: np.ndarray, y: np.ndarray,
    dec_a: np.ndarray, dec_b: np.ndarray, *, frac: float = 0.5,
    max_risk: float = 0.5,
) -> np.ndarray:
    """The same stakes settled at the price a bettor can actually get.

    The fair-odds process is the statistical object; this one is the
    deployable object. Staking f = lambda*q of wealth on A at decimal
    `dec_a` (rather than at the fair 1/q) gives

        E[M | H0] = 1 - f * (1 - q * dec_a)  <=  1

    because q * dec_a < 1 whenever the book charges an overround. The
    process is therefore a SUPERmartingale under the same null: still a
    valid e-value, uniformly conservative, and short of the fair-odds one by
    exactly what the margin costs. That shortfall is a measurement, not an
    artefact, and it is reported as one.
    """
    q = np.clip(np.asarray(q, dtype=float), 1e-6, 1 - 1e-6)
    y = np.asarray(y, dtype=float)
    lam = clip_lambda(frac * kelly_lambda(p, q), q, max_risk)
    f_a = np.where(lam >= 0, lam * q, 0.0)            # fraction staked on A
    f_b = np.where(lam < 0, -lam * (1.0 - q), 0.0)    # fraction staked on B
    da = np.asarray(dec_a, dtype=float)
    db = np.asarray(dec_b, dtype=float)
    win_a = 1.0 - f_a + f_a * da
    lose_a = 1.0 - f_a
    win_b = 1.0 - f_b + f_b * db
    lose_b = 1.0 - f_b
    return np.where(y > 0.5, win_a * lose_b, lose_a * win_b)


# -- e-values ----------------------------------------------------------


def evalue(increments: np.ndarray) -> float:
    """Terminal wealth. Computed in log space; a 300-bout product underflows."""
    return float(np.exp(np.sum(np.log(np.maximum(increments, EPS)))))


def running_evalue(increments: np.ndarray) -> np.ndarray:
    return np.exp(np.cumsum(np.log(np.maximum(increments, EPS))))


def ville_crossing(increments: np.ndarray, alpha: float = 0.05) -> int:
    """Index of the first bout at which wealth crosses 1/alpha, else -1.

    This is the whole operational point of an e-process here. The fixed-n
    analysis has to name its sample size in advance and wait; a bettor
    watching this number can stop the moment it crosses, having spent no
    extra alpha for having looked every week.
    """
    run = running_evalue(increments)
    hit = np.nonzero(run >= 1.0 / alpha)[0]
    return int(hit[0]) if len(hit) else -1


def log_growth(increments: np.ndarray) -> float:
    """Realised log-wealth per bout — the e-power estimate."""
    if len(increments) == 0:
        return 0.0
    return float(np.mean(np.log(np.maximum(increments, EPS))))


def bouts_to_reject(increments: np.ndarray, alpha: float = 0.05) -> float:
    """How many bouts at the observed growth rate to reach e = 1/alpha.

    The replacement for docs/edge_segments.md §0's '~89,900 bouts'. That
    number answers 'how large must a fixed sample be for a test I will run
    once'; this one answers 'how long must I keep betting', which is the
    question the project actually faces, and it is smaller because the
    sequential test does not have to pay for a sample size chosen in
    advance.
    """
    g = log_growth(increments)
    if g <= 0:
        return float("inf")
    return float(np.log(1.0 / alpha) / g)


# -- multiplicity ------------------------------------------------------


def e_bh(evalues: np.ndarray, alpha: float = 0.05) -> np.ndarray:
    """e-BH (Wang & Ramdas 2022). FDR <= alpha under ARBITRARY dependence.

    That last clause is why this procedure and not BH. The 84 segments are
    overlapping subsets of one pool of 1,787 bouts scored by one model
    against one book: a single upset moves dozens of them together, in a
    direction and with a correlation structure nobody has characterised.
    BH's guarantee needs independence or PRDS and neither is available here;
    the classical repair is Benjamini-Yekutieli, which charges
    sum(1/i) ~ 4.4x on 84 hypotheses. e-BH charges nothing.
    """
    e = np.asarray(evalues, dtype=float)
    K = len(e)
    order = np.argsort(-e)
    sorted_e = e[order]
    k_star = 0
    for k in range(K, 0, -1):
        if sorted_e[k - 1] >= K / (alpha * k):
            k_star = k
            break
    rejected = np.zeros(K, dtype=bool)
    if k_star:
        rejected[order[:k_star]] = True
    return rejected


def e_bh_threshold(evalues: np.ndarray, alpha: float = 0.05) -> float:
    """The e-value cutoff e-BH ends up applying, for reporting."""
    e = np.asarray(evalues, dtype=float)
    K = len(e)
    sorted_e = np.sort(e)[::-1]
    for k in range(K, 0, -1):
        if sorted_e[k - 1] >= K / (alpha * k):
            return float(K / (alpha * k))
    return float("inf")


def by_qvalues(pvals: np.ndarray) -> np.ndarray:
    """Benjamini-Yekutieli — BH's correct-under-arbitrary-dependence twin."""
    p = np.asarray(pvals, dtype=float)
    n = len(p)
    c = float(np.sum(1.0 / np.arange(1, n + 1)))
    order = np.argsort(p)
    ranked = p[order] * n * c / (np.arange(n) + 1)
    q = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.clip(q, 0, 1)
    return out


def mixture_evalue(evalue_paths: list[np.ndarray], weights: np.ndarray | None = None) -> np.ndarray:
    """Convex mixture of test martingales — itself a test martingale.

    This is how a post-hoc threshold gets paid for. `docs/edge_segments.md`
    §6 declares its own rule post-hoc: the cut at lean >= 0.05 was chosen
    after seeing that the discovery sweep was positive from 0.02 to 0.22 and
    peaked at 0.13. Reporting max-over-threshold is then not a valid e-value
    and the honest fixed-n repair is a penalty nobody knows how to size.

    A mixture needs no penalty. Each threshold's wealth process is a
    martingale starting at 1; a fixed convex combination of them starts at 1
    and is a martingale; its terminal value is a valid e-value for the
    intersection null 'the book is calibrated at every threshold'. The
    search is paid for by the prior mass not placed on the winner, which is
    a price you can write down in advance instead of arguing about after.
    """
    n = max(len(path) for path in evalue_paths)
    K = len(evalue_paths)
    if weights is None:
        weights = np.full(K, 1.0 / K)
    acc = np.zeros(n)
    for w, path in zip(weights, evalue_paths, strict=True):
        padded = np.empty(n)
        padded[: len(path)] = path
        if len(path) < n:
            padded[len(path):] = path[-1] if len(path) else 1.0
        acc += w * padded
    return acc


# -- anytime-valid confidence sequence on ROI --------------------------


def betting_cs(
    x: np.ndarray, *, alpha: float = 0.05, grid: np.ndarray | None = None,
    lo: float = 0.0, hi: float = 1.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Anytime-valid CS for the mean of a [lo, hi]-bounded sequence.

    Hedged capital (Waudby-Smith & Ramdas): for each candidate mean m, run
    TWO capital processes, one betting that the truth is above m and one
    that it is below, and keep m while the even mixture of the pair has
    never reached 1/alpha. The mixture is a non-negative martingale with
    unit initial value, so Ville applies to it directly and the two-sided
    interval costs no union bound.

    A single-signed process only ever excludes candidates on one side, which
    is a silent way to report an interval whose upper end is the grid.

    The result holds at every sample size simultaneously — which the cluster
    bootstrap in docs/edge_segments.md 6 does not. That interval is valid at
    the one n the lab stopped at, and the lab stopped at an n it chose after
    watching the number.
    """
    z = (np.asarray(x, dtype=float) - lo) / (hi - lo)
    n = len(z)
    if grid is None:
        grid = np.linspace(0.001, 0.999, 999)
    running_mean = np.concatenate([[0.5], np.cumsum(z)[:-1] / np.arange(1, n)])
    running_var = np.full(n, 0.25)
    if n > 1:
        sq = np.cumsum((z - running_mean) ** 2)
        running_var[1:] = np.maximum(sq[:-1] / np.arange(1, n), 1e-4)
    t_idx = np.arange(1, n + 1, dtype=float)
    lam_base = np.sqrt(2 * np.log(1.0 / alpha) / (running_var * t_idx * np.log1p(t_idx)))
    keep_lo = np.full(n, np.nan)
    keep_hi = np.full(n, np.nan)
    thresh = 1.0 / alpha
    crossed_at = np.full(len(grid), np.inf)
    for j, m in enumerate(grid):
        lam = np.minimum(lam_base, 0.5 / max(m, 1e-6))
        lam = np.minimum(lam, 0.5 / max(1 - m, 1e-6))
        up = np.cumsum(np.log(np.maximum(1.0 + lam * (z - m), EPS)))
        dn = np.cumsum(np.log(np.maximum(1.0 - lam * (z - m), EPS)))
        mixed = 0.5 * np.exp(up) + 0.5 * np.exp(dn)
        hit = np.nonzero(mixed >= thresh)[0]
        if len(hit):
            crossed_at[j] = hit[0]
    for t in range(n):
        alive = grid[crossed_at > t]
        if len(alive):
            keep_lo[t] = alive.min() * (hi - lo) + lo
            keep_hi[t] = alive.max() * (hi - lo) + lo
    return keep_lo, keep_hi

"""The single scoring routine every segment in the lab goes through.

One file, because the failure mode this lab is built to avoid is not a wrong
formula — it is two segments scored slightly differently and then ranked
against each other. Every number printed anywhere in `lab_edge_segments.py`
comes out of `score_segment` below.

What a segment gets asked, in order:

  1. Is our per-bout log-loss lower than the closing line's ON THE SAME BOUTS?
     Paired, so the segment being intrinsically hard or easy cancels.
  2. Is that difference bigger than the noise, with the standard error
     CLUSTERED BY EVENT? Twelve bouts on one card are not twelve independent
     draws on the book's pricing.
  3. Is it bigger than the noise after the segment's own market-confidence
     COMPOSITION is removed? A slice made mostly of coin-flips inherits the
     coin-flip bucket's average edge without having any of its own.
  4. Could the difference even have been seen? — the minimum detectable
     effect at this n, printed next to every row, so "nothing found" can be
     told apart from "nothing findable".
  5. Does it survive the multiplicity of the whole grid (BH q-value, applied
     by the caller across all segments at once)?
  6. Does it hold up across five model seeds and across the two halves of the
     discovery window?
  7. If the segment names a side: are we ABOVE or BELOW the truth on that
     side, and is the book on the same side of it? That is the difference
     between "we are noisier here" and "there is a directional bias to bet".
  8. Would betting it at the real vigged closing price have made money?
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import norm

EPS = 1e-6


def per_bout_logloss(p: np.ndarray, y: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=float), EPS, 1 - EPS)
    y = np.asarray(y, dtype=float)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def cluster_se(d: np.ndarray, clusters: np.ndarray) -> float:
    """Cluster-robust standard error of the mean of `d`.

    The sandwich estimator for the intercept-only regression: sum the residuals
    WITHIN each cluster first, then take the variance across cluster sums. With
    singleton clusters it collapses to the ordinary SE, which is the right
    limiting behaviour.
    """
    n = len(d)
    if n < 2:
        return float("nan")
    dbar = d.mean()
    r = d - dbar
    _, inv = np.unique(clusters, return_inverse=True)
    sums = np.bincount(inv, weights=r)
    g = len(sums)
    if g < 2:
        return float(np.sqrt((r**2).sum()) / n)
    # Small-sample (CR1) scaling — with ~40 clusters the unscaled sandwich is
    # visibly optimistic, and this lab fails segments on standard errors.
    scale = (g / (g - 1)) * ((n - 1) / max(n - 2, 1))
    return float(np.sqrt(scale * (sums**2).sum()) / n)


def cluster_bootstrap_ci(
    d: np.ndarray, clusters: np.ndarray, n_boot: int = 4000, seed: int = 11
) -> tuple[float, float]:
    uniq, inv = np.unique(clusters, return_inverse=True)
    order = np.argsort(inv, kind="stable")
    d_sorted = d[order]
    starts = np.searchsorted(np.sort(inv), np.arange(len(uniq)), side="left")
    ends = np.searchsorted(np.sort(inv), np.arange(len(uniq)), side="right")
    groups = [d_sorted[s:e] for s, e in zip(starts, ends, strict=True)]
    rng = np.random.default_rng(seed)
    k = len(groups)
    boots = np.empty(n_boot)
    for i in range(n_boot):
        pick = rng.integers(0, k, k)
        boots[i] = np.concatenate([groups[j] for j in pick]).mean()
    return float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))


def mde(sd: float, n: int, power: float = 0.80) -> float:
    """One-sided 5% / `power` minimum detectable effect."""
    if n <= 1 or not np.isfinite(sd) or sd <= 0:
        return float("inf")
    return float((norm.ppf(0.95) + norm.ppf(power)) * sd / np.sqrt(n))


def bh_fdr(pvals: np.ndarray) -> np.ndarray:
    p = np.asarray(pvals, dtype=float)
    ok = np.isfinite(p)
    out = np.full(len(p), np.nan)
    pp = p[ok]
    n = len(pp)
    if n == 0:
        return out
    order = np.argsort(pp)
    ranked = pp[order] * n / (np.arange(n) + 1)
    q = np.minimum.accumulate(ranked[::-1])[::-1]
    res = np.empty(n)
    res[order] = np.clip(q, 0, 1)
    out[ok] = res
    return out


def bucket_residual_delta(frame: pd.DataFrame, delta_col: str = "_d") -> np.ndarray:
    """Per-bout delta with the GLOBAL market-confidence-bucket mean removed.

    The confound this exists for: the gap to the closing line is not spread
    evenly over the confidence range — the model is at parity on coin-flips and
    loses almost all of it in the 0.72+ bucket (docs/tail_resolution.md). So any
    slice that happens to be short of heavy favourites looks good without being
    good, and any slice full of them looks bad without being bad. Centring each
    bout on its own bucket's global mean asks the sharper question: is this
    segment better than other bouts the book was EQUALLY CONFIDENT about?
    """
    d = frame[delta_col].to_numpy(dtype=float)
    means = frame.groupby("market_bucket", observed=True)[delta_col].transform("mean")
    return d - means.to_numpy(dtype=float)


def roi_at_close(
    p: np.ndarray, dec_a: np.ndarray, dec_b: np.ndarray, y: np.ndarray, thr: float
) -> dict[str, float]:
    """Flat-stake return betting the model's edge into the closing price.

    Both sides are priced, the better expected value is taken, and the bet is
    placed only if it clears `thr`. The book's ~4.7 % overround is IN these
    numbers — that is the point. A segment can beat the closing line's implied
    probabilities and still lose money, and the owner needs to see which one
    this is.
    """
    ev_a = p * dec_a - 1.0
    ev_b = (1 - p) * dec_b - 1.0
    take_a = ev_a >= ev_b
    ev = np.where(take_a, ev_a, ev_b)
    dec = np.where(take_a, dec_a, dec_b)
    won = np.where(take_a, y == 1, y == 0)
    bet = np.isfinite(ev) & (ev > thr)
    n = int(bet.sum())
    if n == 0:
        return {"n_bets": 0, "roi": float("nan"), "profit": 0.0}
    ret = np.where(won[bet], dec[bet] - 1.0, -1.0)
    return {"n_bets": n, "roi": float(ret.mean()), "profit": float(ret.sum())}


def score_segment(
    frame: pd.DataFrame,
    mask_a: np.ndarray,
    mask_b: np.ndarray,
    *,
    symmetric: bool,
    prob_col: str = "p",
) -> dict:
    """Every statistic for one segment on one window. `frame` is already
    filtered to one seed, one window, and `has_market`."""
    sel = mask_a | mask_b
    n = int(sel.sum())
    out: dict = {"n": n, "n_events": int(frame.loc[sel, "event_id"].nunique())}
    if n < 10:
        return out

    sub = frame.loc[sel]
    p = sub[prob_col].to_numpy(dtype=float)
    m = sub["market"].to_numpy(dtype=float)
    y = sub["y"].to_numpy(dtype=int)
    ll_m = per_bout_logloss(p, y)
    ll_k = per_bout_logloss(m, y)
    d = ll_m - ll_k
    clusters = sub["event_id"].to_numpy()

    se = cluster_se(d, clusters)
    lo, hi = cluster_bootstrap_ci(d, clusters)
    out.update(
        logloss_model=float(ll_m.mean()),
        logloss_market=float(ll_k.mean()),
        delta=float(d.mean()),          # negative == the model is better
        delta_se=se,
        delta_lo=lo,
        delta_hi=hi,
        p_value=float(2 * norm.sf(abs(d.mean() / se))) if se and np.isfinite(se) else float("nan"),
        mde=mde(float(d.std(ddof=1)), n),
        acc_model=float(((p >= 0.5).astype(int) == y).mean()),
        acc_market=float(((m >= 0.5).astype(int) == y).mean()),
        market_conf_mean=float(sub["market_conf"].mean()),
        share_of_pool=float(n / max(len(frame), 1)),
    )

    # Composition-adjusted twin.
    r_all = bucket_residual_delta(frame.assign(_d=per_bout_logloss(frame[prob_col], frame["y"])
                                               - per_bout_logloss(frame["market"], frame["y"])))
    r = r_all[sel]
    se_r = cluster_se(r, clusters)
    out.update(
        delta_adj=float(r.mean()),
        delta_adj_se=se_r,
        p_value_adj=float(2 * norm.sf(abs(r.mean() / se_r))) if se_r and np.isfinite(se_r) else float("nan"),
    )

    # Direction: what do we say about the named side, what does the book say,
    # and what happened. Only meaningful when a side is named.
    if not symmetric:
        p_side = np.concatenate([frame.loc[mask_a, prob_col], 1 - frame.loc[mask_b, prob_col]])
        m_side = np.concatenate([frame.loc[mask_a, "market"], 1 - frame.loc[mask_b, "market"]])
        y_side = np.concatenate([frame.loc[mask_a, "y"], 1 - frame.loc[mask_b, "y"]])
        out.update(
            model_p_side=float(np.mean(p_side)),
            market_p_side=float(np.mean(m_side)),
            actual_side=float(np.mean(y_side)),
            model_bias=float(np.mean(p_side) - np.mean(y_side)),
            market_bias=float(np.mean(m_side) - np.mean(y_side)),
        )

    if "dec_a" in sub.columns:
        dec_a = sub["dec_a"].to_numpy(dtype=float)
        dec_b = sub["dec_b"].to_numpy(dtype=float)
        for thr in (0.0, 0.05, 0.10):
            key = f"roi_{int(thr * 100):02d}"
            r_ = roi_at_close(p, dec_a, dec_b, y, thr)
            out[f"{key}_n"] = r_["n_bets"]
            out[key] = r_["roi"]
    return out

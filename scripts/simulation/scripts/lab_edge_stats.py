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


def mde_from_se(se: float, power: float = 0.80) -> float:
    """One-sided 5% / `power` minimum detectable effect, from a given SE.

    Takes the standard error rather than (sd, n) so the caller cannot pair a
    clustered p-value with an iid detection floor — which is how a lab ends up
    claiming it could have seen something it could not.
    """
    if not np.isfinite(se) or se <= 0:
        return float("inf")
    return float((norm.ppf(0.95) + norm.ppf(power)) * se)


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


def bucket_adjusted_contrast(
    d: np.ndarray, sel: np.ndarray, buckets: pd.Series, clusters: np.ndarray
) -> tuple[float, float]:
    """Segment-vs-rest difference in Δ, WITHIN market-confidence bucket.

    The confound this exists for: the gap to the closing line is not spread
    evenly over the confidence range — the model is at parity on coin-flips and
    loses nearly all of it above 0.72 (docs/tail_resolution.md). So a slice
    short of heavy favourites looks good without being good.

    The first version of this centred each bout on its bucket's mean over the
    WHOLE frame — which puts the segment inside its own control group, and
    attenuates the contrast by exactly (1 − share_of_pool). On a synthetic
    frame with a true edge of −0.1000 it reported −0.095 at a 5 % share and
    −0.060 at 40 %. It was not a small error: correcting it moved four
    pre-registered segments across q < 0.05, and took the lab's best
    composition-adjusted slice from q = 0.070 to q = 0.017. Adversarial
    verification found it; the arithmetic above is its demonstration.

    What replaces it is the textbook estimator — regress the per-bout Δ on a
    segment dummy plus bucket fixed effects and read the dummy — with a
    cluster-robust standard error by event. Returns (contrast, se); a segment
    that IS a bucket (`market_conf >= 0.72`) is not estimable and returns NaN
    rather than a fabricated zero, which is what the old code printed.
    """
    S = np.asarray(sel, dtype=float)
    codes = pd.Categorical(buckets).codes
    keep = codes >= 0
    if keep.sum() < 10:
        return float("nan"), float("nan")
    d, S, codes, clusters = d[keep], S[keep], codes[keep], np.asarray(clusters)[keep]

    # Drop buckets with no within-bucket variation in S — they contribute
    # nothing to a fixed-effects contrast and make the design rank-deficient.
    ok = np.zeros(len(S), dtype=bool)
    for b in np.unique(codes):
        m = codes == b
        if 0 < S[m].mean() < 1:
            ok |= m
    if ok.sum() < 10 or not (0 < S[ok].mean() < 1):
        return float("nan"), float("nan")
    d, S, codes, clusters = d[ok], S[ok], codes[ok], clusters[ok]

    dummies = np.zeros((len(S), len(np.unique(codes))))
    for j, b in enumerate(np.unique(codes)):
        dummies[codes == b, j] = 1.0
    X = np.column_stack([dummies, S])
    XtX_inv = np.linalg.pinv(X.T @ X)
    beta = XtX_inv @ (X.T @ d)
    r = d - X @ beta

    _, inv = np.unique(clusters, return_inverse=True)
    g = inv.max() + 1
    meat = np.zeros((X.shape[1], X.shape[1]))
    for j in range(g):
        m = inv == j
        s = X[m].T @ r[m]
        meat += np.outer(s, s)
    scale = (g / max(g - 1, 1)) * ((len(d) - 1) / max(len(d) - X.shape[1], 1))
    V = XtX_inv @ (scale * meat) @ XtX_inv
    return float(beta[-1]), float(np.sqrt(max(V[-1, -1], 0.0)))


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
        # MDE off the CLUSTERED standard error, not the iid one. Reporting a
        # detection floor computed one way beside a p-value computed another
        # understates the floor by up to 24 % on the confirmation window.
        mde=mde_from_se(se),
        acc_model=float(((p >= 0.5).astype(int) == y).mean()),
        acc_market=float(((m >= 0.5).astype(int) == y).mean()),
        market_conf_mean=float(sub["market_conf"].mean()),
        share_of_pool=float(n / max(len(frame), 1)),
    )

    # Composition-adjusted twin: the segment against bouts the book was
    # EQUALLY confident about, estimated with the segment held out of its own
    # control group.
    d_all = (per_bout_logloss(frame[prob_col], frame["y"])
             - per_bout_logloss(frame["market"], frame["y"]))
    adj, adj_se = bucket_adjusted_contrast(
        d_all, sel, frame["market_bucket"], frame["event_id"].to_numpy()
    )
    out.update(
        delta_adj=adj,
        delta_adj_se=adj_se,
        p_value_adj=(float(2 * norm.sf(abs(adj / adj_se)))
                     if adj_se and np.isfinite(adj_se) and adj_se > 0 else float("nan")),
    )

    # Direction: what do we say about the named side, what does the book say,
    # and what happened. Only meaningful when a side is named.
    #
    # Rows where BOTH fighters satisfy the condition are dropped rather than
    # counted twice. Entering such a bout in both orientations adds p and
    # (1 − p) against y and (1 − y): it contributes exactly zero to the bias
    # and pulls every level toward 0.5, which is a diluted table dressed up as
    # a bigger one. 36 of the 61 side-naming segments have some overlap.
    if not symmetric:
        both = mask_a & mask_b
        only_a, only_b = mask_a & ~both, mask_b & ~both
        n_dir = int(only_a.sum() + only_b.sum())
        out["n_direction"] = n_dir
        out["n_direction_dropped"] = int(both.sum())
        if n_dir >= 10:
            p_side = np.concatenate([frame.loc[only_a, prob_col], 1 - frame.loc[only_b, prob_col]])
            m_side = np.concatenate([frame.loc[only_a, "market"], 1 - frame.loc[only_b, "market"]])
            y_side = np.concatenate([frame.loc[only_a, "y"], 1 - frame.loc[only_b, "y"]])
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

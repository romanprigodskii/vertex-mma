"""The high-power version of the same question.

Slicing 1,200 bouts into sixty segments and comparing log-loss inside each is
the intuitive test and the weakest one: each slice throws away 95 % of the
sample, and the multiplicity correction then charges for all sixty. This module
asks the same thing with every bout participating in every estimate.

Two regressions, both fitted on the logit scale, both without an intercept —
the frame is symmetrized, so an intercept would be fitting which slot the
scrape happened to list the winner in.

  SHRINKAGE.   y ~ sigmoid( z_market + γ·(z_model − z_market) )

    γ is the fraction of our DISAGREEMENT with the book that is signal.
    γ = 0  : every deviation we make from the closing line is noise.
    γ = 1  : our probability is the right one and the book's is redundant.
    0<γ<1  : the honest blend is z_market + γ·(z_model − z_market), which is
             also the best forecast obtainable from the two.
    γ < 0  : our deviations are actively wrong — fade them.

    Then γ = γ₀ + γ₁·S for a segment indicator S. γ₁ > 0 is the precise
    statement of "we are stronger than the bookmaker HERE": not that our
    log-loss is lower on that slice, but that our disagreement carries more
    information there than it does elsewhere.

  ENCOMPASSING. y ~ sigmoid( b·z_market + c·z_model )

    The classical forecast-encompassing test. c > 0 says the model carries
    information the closing line does not already contain, whatever the two
    log-losses happen to be.

Standard errors are clustered by event throughout. Bouts on one card share a
night, a venue and one pricing session, and treating them as independent is how
a lab talks itself into an edge.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.stats import norm

EPS = 1e-9


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=float), EPS, 1 - EPS)
    return np.log(p / (1 - p))


def _fit_logit_no_intercept(
    X: np.ndarray, y: np.ndarray, clusters: np.ndarray, offset: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """(coefficients, cluster-robust covariance) for a logistic fit.

    Hand-rolled rather than statsmodels because the simulation venv is the one
    production trains in — a lab is not a reason to add a dependency to it.
    The sandwich is the textbook one: bread = (XᵀWX)⁻¹, meat = Σ over clusters
    of the summed score, which is what makes twelve bouts from one card count
    as one draw and not twelve.
    """
    off = np.zeros(len(y)) if offset is None else np.asarray(offset, dtype=float)

    def nll(beta: np.ndarray) -> float:
        eta = np.clip(X @ beta + off, -30, 30)
        return float(np.logaddexp(0, eta).sum() - (y * eta).sum())

    def grad(beta: np.ndarray) -> np.ndarray:
        eta = np.clip(X @ beta + off, -30, 30)
        p = 1 / (1 + np.exp(-eta))
        return X.T @ (p - y)

    res = minimize(nll, np.zeros(X.shape[1]), jac=grad, method="BFGS")
    beta = res.x
    eta = np.clip(X @ beta + off, -30, 30)
    p = 1 / (1 + np.exp(-eta))
    W = p * (1 - p)
    bread = np.linalg.pinv((X * W[:, None]).T @ X)

    resid = (y - p)[:, None] * X
    _, inv = np.unique(clusters, return_inverse=True)
    g = inv.max() + 1
    meat = np.zeros((X.shape[1], X.shape[1]))
    for j in range(g):
        s = resid[inv == j].sum(axis=0)
        meat += np.outer(s, s)
    scale = g / max(g - 1, 1)
    return beta, bread @ (scale * meat) @ bread


def _wald(beta: float, var: float) -> tuple[float, float, float]:
    se = float(np.sqrt(max(var, 0.0)))
    if se == 0 or not np.isfinite(se):
        return se, float("nan"), float("nan")
    z = beta / se
    return se, float(2 * norm.sf(abs(z))), z


def add_blend(
    frame: pd.DataFrame, *, prob_col: str = "p", n_folds: int = 5, seed: int = 3
) -> pd.DataFrame:
    """Attach `p_blend` — the deployable object this lab actually found.

    The standalone model loses to the closing line and betting it loses money.
    The combination does not, so the combination is what gets measured on
    segments. Two fitting regimes, and the distinction is the whole honesty of
    the ROI table further down:

      * DISCOVERY rows get an OUT-OF-FOLD blend, folds cut by EVENT so a card
        never straddles the boundary. Fitting the weights on all of discovery
        and then reporting discovery ROI would be reporting the fit.
      * CONFIRMATION rows get the blend fitted on all of discovery — the
        genuinely prospective arrangement, and the one a bettor would have had.
    """
    f = frame.copy()
    has = f["has_market"].to_numpy() & f["market"].notna().to_numpy()
    f["p_blend"] = np.nan

    disc = has & f["is_discovery"].to_numpy()
    conf = has & ~f["is_discovery"].to_numpy()

    def fit(rows: np.ndarray) -> np.ndarray:
        sub = f.loc[rows]
        X = np.column_stack([logit(sub["market"].to_numpy()), logit(sub[prob_col].to_numpy())])
        beta, _ = _fit_logit_no_intercept(X, sub["y"].to_numpy(dtype=float),
                                          sub["event_id"].to_numpy())
        return beta

    def apply(beta: np.ndarray, rows: np.ndarray) -> np.ndarray:
        sub = f.loc[rows]
        z = beta[0] * logit(sub["market"].to_numpy()) + beta[1] * logit(sub[prob_col].to_numpy())
        return 1 / (1 + np.exp(-np.clip(z, -30, 30)))

    events = f.loc[disc, "event_id"].astype(str).unique()
    rng = np.random.default_rng(seed)
    fold_of = dict(zip(events, rng.integers(0, n_folds, len(events)), strict=True))
    ev_col = f["event_id"].astype(str)
    for k in range(n_folds):
        in_fold = disc & (ev_col.map(lambda e: fold_of.get(e, -1)) == k).to_numpy()
        out_fold = disc & ~in_fold
        if in_fold.sum() == 0 or out_fold.sum() < 50:
            continue
        f.loc[in_fold, "p_blend"] = apply(fit(out_fold), in_fold)

    if conf.sum():
        f.loc[conf, "p_blend"] = apply(fit(disc), conf)
    return f


def shrinkage(frame: pd.DataFrame, prob_col: str = "p") -> dict:
    """Global γ — how much of our disagreement with the book is signal."""
    z_m = logit(frame["market"].to_numpy())
    z_p = logit(frame[prob_col].to_numpy())
    y = frame["y"].to_numpy(dtype=float)
    X = (z_p - z_m)[:, None]
    beta, cov = _fit_logit_no_intercept(X, y, frame["event_id"].to_numpy(), offset=z_m)
    se, pval, _ = _wald(beta[0], cov[0, 0])
    return {"gamma": float(beta[0]), "se": se, "p_value": pval,
            "lo": float(beta[0] - 1.96 * se), "hi": float(beta[0] + 1.96 * se),
            "n": int(len(y)), "n_events": int(frame["event_id"].nunique())}


def encompassing(frame: pd.DataFrame, prob_col: str = "p") -> dict:
    """b·z_market + c·z_model. c > 0 = we carry information the book does not."""
    z_m = logit(frame["market"].to_numpy())
    z_p = logit(frame[prob_col].to_numpy())
    y = frame["y"].to_numpy(dtype=float)
    X = np.column_stack([z_m, z_p])
    beta, cov = _fit_logit_no_intercept(X, y, frame["event_id"].to_numpy())
    se_b, p_b, _ = _wald(beta[0], cov[0, 0])
    se_c, p_c, _ = _wald(beta[1], cov[1, 1])
    return {"b_market": float(beta[0]), "b_market_se": se_b, "b_market_p": p_b,
            "c_model": float(beta[1]), "c_model_se": se_c, "c_model_p": p_c,
            "n": int(len(y))}


def encompassing_by_segment(
    frame: pd.DataFrame, sel: np.ndarray, prob_col: str = "p"
) -> dict:
    """c = c₀ + c₁·S, with the market's own slope free to vary the same way.

    The preferred segment test, and the reason the constrained γ version below
    is kept only as a readable summary: the unconstrained fit on the full pool
    lands at b + c ≈ 1.20, so the data rejects the b + c = 1 that γ imposes.
    Testing a segment inside a form the pooled data already rejects would put
    the segment's whole burden on a constraint rather than on the segment.

    Both interactions are present. Letting only the model's slope shift by
    segment would credit the model for a slice where it is the BOOK that gets
    sharper or softer, which is the opposite reading.
    """
    z_m = logit(frame["market"].to_numpy())
    z_p = logit(frame[prob_col].to_numpy())
    y = frame["y"].to_numpy(dtype=float)
    S = np.asarray(sel, dtype=float)
    X = np.column_stack([z_m, z_p, z_m * S, z_p * S])
    beta, cov = _fit_logit_no_intercept(X, y, frame["event_id"].to_numpy())
    se3, p3, _ = _wald(beta[3], cov[3, 3])
    return {
        "c_base": float(beta[1]),
        "c_delta": float(beta[3]),
        "c_in": float(beta[1] + beta[3]),
        "c_delta_se": se3,
        "c_delta_p": p3,
        "c_delta_lo": float(beta[3] - 1.96 * se3),
        "c_delta_hi": float(beta[3] + 1.96 * se3),
        "b_base": float(beta[0]),
        "b_in": float(beta[0] + beta[2]),
        "n_in": int(S.sum()),
    }


def shrinkage_by_segment(
    frame: pd.DataFrame, sel: np.ndarray, prob_col: str = "p"
) -> dict:
    """γ = γ₀ + γ₁·S. γ₁ is the segment's claim to being special.

    S enters ONLY through the interaction. It has no main effect and cannot
    have one: the segment indicator is symmetric in the two fighters, so a main
    effect would be a slot preference, and the whole frame is symmetrized
    precisely so that nothing can learn one.
    """
    z_m = logit(frame["market"].to_numpy())
    z_p = logit(frame[prob_col].to_numpy())
    y = frame["y"].to_numpy(dtype=float)
    dz = z_p - z_m
    S = np.asarray(sel, dtype=float)
    X = np.column_stack([dz, dz * S])
    beta, cov = _fit_logit_no_intercept(X, y, frame["event_id"].to_numpy(), offset=z_m)
    se1, p1, _ = _wald(beta[1], cov[1, 1])
    return {
        "gamma_base": float(beta[0]),
        "gamma_delta": float(beta[1]),
        "gamma_in": float(beta[0] + beta[1]),
        "gamma_delta_se": se1,
        "gamma_delta_p": p1,
        "gamma_delta_lo": float(beta[1] - 1.96 * se1),
        "gamma_delta_hi": float(beta[1] + 1.96 * se1),
        "n_in": int(S.sum()),
    }

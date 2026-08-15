"""Shared machinery for the model-vs-market segment search.

Three things live here, and they are separated on purpose:

  * the FRAME — the walk-forward pool joined to per-bout context, plus a
    point-in-time style taxonomy. Built once, identical for every segment.
  * the STATISTICS — one implementation of "is this segment's gap to the
    closing line real", used by every segment, so no two numbers in this lab
    were computed differently.
  * the SEGMENT ALGEBRA — a segment is written once, for the A side, and its
    B-side twin is derived by swapping the `_a`/`_b` suffixes. Membership is
    then `A-side OR B-side`, which is swap-invariant by construction rather
    than by the author remembering to make it so.

The last one is not a convenience. A segment whose membership depends on which
fighter the scrape happened to list first is a segment that measures slot
order, and half of a hand-written grid gets that wrong.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from eval_tail_buckets import load_symmetrized  # noqa: E402

from src.config import DATA_DIR, RESIDUAL_CORRECTION  # noqa: E402
from src.db import get_connection  # noqa: E402
from src.rank_export import build_rank_features, fetch_rankings  # noqa: E402

EPS = 1e-6

# Market-confidence strata, frozen to eval_tail_buckets.MARKET_BUCKETS so the
# adjusted delta below and the per-bucket tables in docs/tail_resolution.md are
# talking about the same four groups.
MARKET_BUCKETS: tuple[tuple[float, float], ...] = (
    (0.50, 0.55),
    (0.55, 0.62),
    (0.62, 0.72),
    (0.72, 1.01),
)


# ── the frame ──────────────────────────────────────────────────────────


def _sig(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -50, 50)))


def _logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=float), 1e-9, 1 - 1e-9)
    return np.log(p / (1 - p))


def apply_served_corrector(pool: pd.DataFrame, diff_age: np.ndarray) -> np.ndarray:
    """Rebuild the served probability from a pool fitted without the corrector.

    `walk_forward` fits bare ensembles; `train.py` is what attaches
    `config.RESIDUAL_CORRECTION`, and only to the served model. So the stored
    `p` is the UNCORRECTED quantity and production's number has to be
    reconstructed. The reconstruction is exact, not approximate: the term is
    additive in logit space and antisymmetric in (A − B), so applying +shift to
    the A ordering and −shift to the B ordering and averaging is literally what
    `predict_proba_a` inside `predict.py`'s order-averaging does.
    """
    if RESIDUAL_CORRECTION is None:
        return pool["p"].to_numpy(dtype=float)
    terms = RESIDUAL_CORRECTION["terms"]
    assert [t["column"] for t in terms] == ["diff_age"], (
        "this lab rebuilds the age term only — a wider corrector needs its "
        "columns joined onto the pool first"
    )
    w, scale = float(terms[0]["weight"]), float(terms[0]["scale"])
    slope = float(RESIDUAL_CORRECTION.get("slope", 1.0))
    shift = w * np.nan_to_num(diff_age / scale, nan=0.0)
    p_raw = _sig(slope * _logit(pool["p_raw"].to_numpy()) + shift)
    p_sw = _sig(slope * _logit(pool["p_sw"].to_numpy()) - shift)
    return 0.5 * (p_raw + (1.0 - p_sw))


# Style axes. Every input is a career-to-date average as of the bout — the same
# point-in-time columns the model trains on — so an archetype cannot see the
# fight it labels.
#
# Two axes, not one, because the question the lab was opened for ("a striker
# against an all-rounder") is a statement about a fighter being high on BOTH
# axes, which a single striker↔grappler spectrum cannot express: it puts the
# all-rounder in the middle, next to the fighter who is good at neither.
STRIKE_INPUTS = ("slpm", "kd_per_fight", "distance_share", "str_acc")
GRAPPLE_INPUTS = ("td_per15", "control_per_min", "sub_per15", "ground_share")


def _z(series: pd.Series, ref: pd.Series) -> pd.Series:
    """z-score against a REFERENCE distribution, robustly.

    Median/IQR rather than mean/sd: `sub_per15` and `kd_per_fight` are
    long-tailed enough that one Jon Jones-shaped outlier moves a mean-based
    threshold across a hundred fighters.
    """
    med = float(ref.median())
    iqr = float(ref.quantile(0.75) - ref.quantile(0.25))
    if not np.isfinite(iqr) or iqr <= 0:
        iqr = float(ref.std()) or 1.0
    return (series - med) / iqr


@dataclass
class StyleScale:
    """Frozen thresholds, fitted on the discovery window only.

    Fitted where the search happens and applied unchanged to the confirmation
    window, so a segment cannot quietly redefine itself between the two. The
    same discipline is what makes the rule usable prospectively: an upcoming
    bout gets labelled by numbers that were fixed before it happened.
    """

    ref: dict[str, tuple[float, float]] = field(default_factory=dict)
    strike_cut: float = 0.0
    grapple_cut: float = 0.0


def fit_style_scale(disc: pd.DataFrame) -> StyleScale:
    scale = StyleScale()
    both = {}
    for col in STRIKE_INPUTS + GRAPPLE_INPUTS:
        ref = pd.concat([
            pd.to_numeric(disc[f"{col}_a"], errors="coerce"),
            pd.to_numeric(disc[f"{col}_b"], errors="coerce"),
        ]).dropna()
        med = float(ref.median())
        iqr = float(ref.quantile(0.75) - ref.quantile(0.25)) or float(ref.std()) or 1.0
        scale.ref[col] = (med, iqr)
        both[col] = ref
    strike, grapple = [], []
    for side in ("a", "b"):
        s, g = _style_axes(disc, side, scale)
        strike.append(s)
        grapple.append(g)
    # Median split on the pooled fighter-sides. A median is the honest cut
    # here: any "striker" threshold picked to make a segment look good is the
    # search happening inside the definition instead of in front of it.
    scale.strike_cut = float(pd.concat(strike).median())
    scale.grapple_cut = float(pd.concat(grapple).median())
    return scale


def _style_axes(df: pd.DataFrame, side: str, scale: StyleScale) -> tuple[pd.Series, pd.Series]:
    def z(col: str) -> pd.Series:
        med, iqr = scale.ref[col]
        return (pd.to_numeric(df[f"{col}_{side}"], errors="coerce") - med) / iqr

    strike = sum(z(c) for c in STRIKE_INPUTS) / len(STRIKE_INPUTS)
    grapple = sum(z(c) for c in GRAPPLE_INPUTS) / len(GRAPPLE_INPUTS)
    return strike, grapple


def assign_style(df: pd.DataFrame, scale: StyleScale) -> pd.DataFrame:
    """Add `strike_{a,b}`, `grapple_{a,b}` and the four archetype flags.

    The 2×2 the axes cut out:

        strike high, grapple low   → striker      (a "boxer", in the ask)
        strike low,  grapple high  → grappler
        both high                  → universal    (the all-rounder)
        both low                   → low_output   (grinders, point fighters,
                                                   and the merely inactive)

    `low_output` is not a slur, it is the residual class, and naming it keeps
    the other three clean: without it every fighter who is unremarkable on both
    axes gets swept into whichever archetype has the looser threshold.
    """
    out = pd.DataFrame(index=df.index)
    for side in ("a", "b"):
        s, g = _style_axes(df, side, scale)
        out[f"strike_{side}"] = s
        out[f"grapple_{side}"] = g
        hi_s = s >= scale.strike_cut
        hi_g = g >= scale.grapple_cut
        known = s.notna() & g.notna()
        out[f"is_striker_{side}"] = (known & hi_s & ~hi_g).astype(int)
        out[f"is_grappler_{side}"] = (known & ~hi_s & hi_g).astype(int)
        out[f"is_universal_{side}"] = (known & hi_s & hi_g).astype(int)
        out[f"is_low_output_{side}"] = (known & ~hi_s & ~hi_g).astype(int)
        out[f"style_known_{side}"] = known.astype(int)
        out[f"style_{side}"] = np.select(
            [known & hi_s & ~hi_g, known & ~hi_s & hi_g, known & hi_s & hi_g, known],
            ["striker", "grappler", "universal", "low_output"],
            default="unknown",
        )
    return out


CONTEXT_COLUMNS = [
    "event_id", "event_date", "weight_class", "gender", "is_title_fight",
    "is_main_event", "scheduled_rounds", "fighter_a_id", "fighter_b_id",
    "age_a", "age_b", "height_a", "height_b", "reach_a", "reach_b",
    "stance_a", "stance_b", "is_american_a", "is_american_b",
    "layoff_days_a", "layoff_days_b", "prior_bouts_a", "prior_bouts_b",
    "prior_win_rate_a", "prior_win_rate_b",
    "prior_finish_rate_a", "prior_finish_rate_b",
    "current_streak_a", "current_streak_b",
    "elo_a", "elo_b", "glicko_cons_a", "glicko_cons_b",
    "vertex_score_a", "vertex_score_b",
    "recent3_wins_a", "recent3_wins_b",
    "avg_bout_seconds_a", "avg_bout_seconds_b",
    "td_def_a", "td_def_b", "sapm_a", "sapm_b",
    "kd_absorbed_per_fight_a", "kd_absorbed_per_fight_b",
    "finish_against_per_bout_a", "finish_against_per_bout_b",
    "traj_slpm_a", "traj_slpm_b", "traj_sapm_a", "traj_sapm_b",
    "title_bouts_a", "title_bouts_b",
    "preufc_bouts_a", "preufc_bouts_b",
    "str_off_a", "str_off_b", "grap_off_a", "grap_off_b",
    "str_def_a", "str_def_b", "grap_def_a", "grap_def_b",
] + [f"{c}_{s}" for c in STRIKE_INPUTS + GRAPPLE_INPUTS for s in ("a", "b")]


def fetch_closing_decimals() -> pd.DataFrame:
    """Latest scraped decimal per bout — i.e. the closing price.

    `08_scrape_bestfightodds.py` upserts the same row every ~6h, so the most
    recent `fetched_at` for a completed bout is the last line the book showed.
    Needed on top of `market_prob_a` because that column is de-vigged: it is
    the right thing to score probabilities against and the wrong thing to
    settle a bet at.
    """
    sql = """
        SELECT DISTINCT ON (bout_id)
               bout_id, winner_a_decimal, winner_b_decimal, fetched_at
        FROM bout_external_odds
        WHERE winner_a_decimal IS NOT NULL AND winner_b_decimal IS NOT NULL
        ORDER BY bout_id, fetched_at DESC
    """
    with get_connection() as conn:
        return pd.read_sql(sql, conn)


def attach_decimals(frame: pd.DataFrame) -> pd.DataFrame:
    """Join the closing decimals and put them in the FRAME's fighter order.

    `bout_external_odds` is keyed to the bout's own fighter_a; the frame is
    symmetrized, so about half its rows have the two fighters swapped relative
    to the DB. Orientation is recovered per row rather than assumed: de-vig the
    two decimals and see which of `pa` / `1 − pa` reproduces the frame's own
    `market_prob_a`. That is a check, not a guess — a row whose reconstruction
    matches NEITHER (a re-scrape landed after the dataset was cached) is
    dropped rather than settled at a price that may belong to the other man.
    """
    dec = fetch_closing_decimals()
    dec["bout_id"] = dec["bout_id"].astype(str)
    # Both sides cast to plain str first: the pool carries pandas' `str` dtype
    # and psycopg hands back `object`, and merging across the two silently
    # matches nothing at all rather than raising.
    frame["bout_id"] = frame["bout_id"].astype(str)
    frame = frame.merge(
        dec[["bout_id", "winner_a_decimal", "winner_b_decimal"]],
        on="bout_id", how="left",
    )

    da = pd.to_numeric(frame["winner_a_decimal"], errors="coerce")
    db = pd.to_numeric(frame["winner_b_decimal"], errors="coerce")
    pa = (1 / da) / ((1 / da) + (1 / db))
    mkt = pd.to_numeric(frame["market"], errors="coerce")
    same = (pa - mkt).abs() < 1e-6
    flip = ((1 - pa) - mkt).abs() < 1e-6
    ok = same | flip
    frame["dec_a"] = np.where(ok, np.where(same, da, db), np.nan)
    frame["dec_b"] = np.where(ok, np.where(same, db, da), np.nan)
    frame["overround"] = 1 / frame["dec_a"] + 1 / frame["dec_b"]

    # The de-vig matters more than it looks, so both live in the frame.
    #
    # `export.py` splits the overround proportionally (a/(a+b)). That method is
    # known to overstate longshots, and it shows: regressing the outcome on the
    # proportional logit gives a slope of 1.163 (se 0.075, p=0.03 against 1),
    # which reads as "the closing line is under-confident" and is nothing of
    # the sort. Under the power de-vig the same regression gives 1.064
    # (p=0.35) and under Shin 1.094 (p=0.18) — i.e. the book is calibrated and
    # the tilt was ours.
    #
    # This lab therefore scores against the POWER de-vig, because an edge
    # measured against a mis-de-vigged market is partly just the de-vig, and
    # that part cannot be bet. `market_prop` is kept so every number here can
    # be reconciled with the rest of the repo, which uses it.
    frame["market_prop"] = frame["market"]
    frame["market"] = power_devig(frame["dec_a"].to_numpy(dtype=float),
                                  frame["dec_b"].to_numpy(dtype=float))
    return frame.drop(columns=["winner_a_decimal", "winner_b_decimal"])


def power_devig(dec_a: np.ndarray, dec_b: np.ndarray) -> np.ndarray:
    """Remove the overround by raising both implied probabilities to a power.

    Solve qᵃ + qᵇ = 1 for the exponent, per bout. Unlike the proportional
    split, this takes proportionally more away from the longshot, which is
    where books actually put their margin.
    """
    from scipy.optimize import brentq

    qa, qb = 1 / dec_a, 1 / dec_b
    out = np.full(len(qa), np.nan)
    for i, (a, b) in enumerate(zip(qa, qb, strict=True)):
        if not (np.isfinite(a) and np.isfinite(b)):
            continue
        try:
            k = brentq(lambda k: a**k + b**k - 1.0, 0.2, 5.0)
        except ValueError:
            continue
        out[i] = a**k
    return out


def build_frame(
    seeds: list[int],
    *,
    pool_glob: str = "lab_edge_pool_seed*.parquet",
    discovery_end: str = "2025-01-01",
    with_odds_decimals: bool = True,
) -> tuple[pd.DataFrame, StyleScale]:
    """(long frame over seed × bout, frozen style scale).

    Rows without a closing line are KEPT — the calibration probes and the
    style-distribution tables are informative on them — and every
    model-vs-market statistic filters to `has_market` itself.
    """
    pools = []
    for path in sorted(DATA_DIR.glob(pool_glob)):
        pools.append(pd.read_parquet(path))
    if not pools:
        raise SystemExit("no pool parquets — run --stage pool first")
    pool = pd.concat(pools, ignore_index=True)
    pool = pool[pool["seed"].isin(seeds)].reset_index(drop=True)

    df = load_symmetrized(use_cache=True).set_index("bout_id")
    keep = [c for c in CONTEXT_COLUMNS if c in df.columns]
    ctx = df.loc[pool["bout_id"], keep].reset_index(drop=True)
    frame = pd.concat([pool.reset_index(drop=True), ctx], axis=1)
    frame["event_date"] = pd.to_datetime(frame["event_date"])

    # Served probability: the pool is uncorrected, production is not.
    diff_age = (
        pd.to_numeric(frame["age_a"], errors="coerce")
        - pd.to_numeric(frame["age_b"], errors="coerce")
    ).to_numpy(dtype=float)
    frame["p_uncorrected"] = frame["p"].to_numpy(dtype=float)
    frame["p"] = apply_served_corrector(frame, diff_age)

    # Rankings — point-in-time, latest snapshot strictly before the bout.
    with get_connection() as conn:
        ranks = fetch_rankings(conn)
    rank_cols = build_rank_features(frame, ranks)
    frame = pd.concat([frame, rank_cols], axis=1)

    frame["is_discovery"] = frame["event_date"] < pd.Timestamp(discovery_end)

    # Style scale is fitted on the DISCOVERY window's bouts only, once, on the
    # de-duplicated bout list rather than on the seed-replicated frame.
    disc_bouts = frame[frame["is_discovery"]].drop_duplicates("bout_id")
    scale = fit_style_scale(disc_bouts)
    frame = pd.concat([frame, assign_style(frame, scale)], axis=1)

    if with_odds_decimals:
        frame = attach_decimals(frame)

    frame = _derive_helpers(frame)
    return frame, scale


def _derive_helpers(f: pd.DataFrame) -> pd.DataFrame:
    """Row-level columns every family wants, computed once.

    Anything symmetric in the two sides goes here; anything that names a side
    stays in the segment expression, where the `_a`/`_b` swap can reach it.
    """
    num = lambda c: pd.to_numeric(f[c], errors="coerce")  # noqa: E731
    # Set here, not earlier: the de-vig runs in `attach_decimals` and a bout
    # whose exponent solve fails has a proportional price and no usable one.
    f["has_market"] = f["market"].notna()
    f["market_conf"] = np.maximum(f["market"], 1 - f["market"])
    f["model_conf"] = np.maximum(f["p"], 1 - f["p"])
    f["market_bucket"] = pd.cut(
        f["market_conf"], bins=[b[0] for b in MARKET_BUCKETS] + [MARKET_BUCKETS[-1][1]],
        labels=[f"{lo:.2f}-{hi:.2f}" for lo, hi in MARKET_BUCKETS], right=False,
    )
    f["disagreement"] = (f["p"] - f["market"]).abs()
    # How much MORE (or less) we give the side the book made favourite. Both
    # probabilities flip together on a side swap, so the quantity is
    # swap-invariant and segments built on it need no `_a`/`_b` twin.
    fav_a = (f["market"] >= 0.5).to_numpy()
    f["lean_fav"] = (
        np.where(fav_a, f["p"], 1 - f["p"]) - np.where(fav_a, f["market"], 1 - f["market"])
    )
    # Do we and the book even name the same favourite?
    f["same_favourite"] = ((f["p"] >= 0.5) == (f["market"] >= 0.5))
    f["age_gap"] = (num("age_a") - num("age_b")).abs()
    f["mean_age"] = (num("age_a") + num("age_b")) / 2
    f["elo_gap"] = (num("elo_a") - num("elo_b")).abs()
    f["is_women"] = (f["gender"].astype(str) == "female").astype(int)
    f["year"] = f["event_date"].dt.year
    f["min_prior_bouts"] = np.minimum(num("prior_bouts_a"), num("prior_bouts_b"))
    f["max_layoff"] = np.maximum(num("layoff_days_a"), num("layoff_days_b"))
    f["n_ranked"] = (
        (f["rank_is_ranked_a"].fillna(0) > 0).astype(int)
        + (f["rank_is_ranked_b"].fillna(0) > 0).astype(int)
    )
    return f


# ── segment algebra ────────────────────────────────────────────────────

_SUFFIX = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*?)_(a|b)\b")


def swap_expr(expr: str) -> str:
    """Mirror an expression by swapping every `_a`/`_b` suffix.

    Deliberately a token rewrite and not a column permutation: the expression
    is what a reader audits, and a reader can check `is_striker_a & is_universal_b`
    became `is_striker_b & is_universal_a` in a way they cannot check a
    reindexed matrix.
    """
    return _SUFFIX.sub(lambda m: f"{m.group(1)}_{'b' if m.group(2) == 'a' else 'a'}", expr)


@dataclass
class Segment:
    """One pre-registered slice.

    `expr_a` names a side: it is read as "the fighter this segment is about is
    in slot A". Membership is `expr_a OR swap(expr_a)`, so it never depends on
    scrape order, and the calibration probe orients every row so the named side
    is the one being scored.

    `symmetric=True` marks a slice that names no side (a title fight, a
    women's bout). Its membership is the same union — `swap` is a no-op on an
    expression with no side suffixes — but the calibration probe is skipped,
    because "what we say about the named side" has no meaning there.
    """

    name: str
    family: str
    expr_a: str
    hypothesis: str = ""
    symmetric: bool = False

    def mask(self, f: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        a = _eval_bool(f, self.expr_a)
        b = a if self.symmetric else _eval_bool(f, swap_expr(self.expr_a))
        return a, b


def _eval_bool(f: pd.DataFrame, expr: str) -> np.ndarray:
    """Evaluate a segment expression to a plain bool array.

    `engine="python"` because half the grid compares string archetypes and
    numexpr cannot; and the NaN is squashed to False explicitly rather than
    left to `astype(bool)`, which maps NaN to TRUE and would silently enrol
    every fighter with a missing date of birth into an age segment.
    """
    s = f.eval(expr, engine="python")
    if not isinstance(s, pd.Series):
        s = pd.Series(s, index=f.index)
    return s.astype("object").where(s.notna(), False).astype(bool).to_numpy()


# ── statistics ─────────────────────────────────────────────────────────


def per_bout_logloss(p: np.ndarray, y: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=float), EPS, 1 - EPS)
    y = np.asarray(y, dtype=float)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def cluster_bootstrap(
    d: np.ndarray, clusters: np.ndarray, n: int = 4000, seed: int = 11
) -> tuple[float, float, float]:
    """(mean, lo, hi) resampling CLUSTERS, not rows.

    Bouts on one card share a venue, a night, a judging crew and — the reason
    it matters here — one book's pricing session. Resampling rows treats twelve
    bouts from the same event as twelve independent draws and returns an
    interval that is too narrow to fail anything.
    """
    uniq, inv = np.unique(clusters, return_inverse=True)
    by_cluster = [d[inv == i] for i in range(len(uniq))]
    rng = np.random.default_rng(seed)
    boots = np.empty(n)
    k = len(uniq)
    for i in range(n):
        pick = rng.integers(0, k, k)
        boots[i] = np.concatenate([by_cluster[j] for j in pick]).mean()
    return float(d.mean()), float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))


def bh_fdr(pvals: np.ndarray) -> np.ndarray:
    """Benjamini-Hochberg q-values.

    The whole point of the lab. Twenty-odd slices, each with a coin-flip
    chance of landing on the good side, produce ten "wins" from a model that
    is uniformly worse than the book. The q-value is what turns that pile back
    into a claim.
    """
    p = np.asarray(pvals, dtype=float)
    n = len(p)
    order = np.argsort(p)
    ranked = p[order] * n / (np.arange(n) + 1)
    q = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.clip(q, 0, 1)
    return out


def mde(sd: float, n: int, power: float = 0.80) -> float:
    """One-sided minimum detectable effect at 5% / `power`.

    Reported next to every segment because "no edge found" and "no edge
    findable" are different results, and on a 120-bout slice the second one is
    usually the true one.
    """
    from scipy.stats import norm

    if n <= 1 or not np.isfinite(sd):
        return float("inf")
    return float((norm.ppf(0.95) + norm.ppf(power)) * sd / np.sqrt(n))

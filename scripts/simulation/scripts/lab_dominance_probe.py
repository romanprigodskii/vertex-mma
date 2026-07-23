"""STAGE 0 — does our under-confidence coincide with blowouts?

The premise of the graded-target lab: the binary label spends the same bit on
a 90-second knockout and a split decision, so the model has no gradient for
"how much better is A", which is exactly the resolution term
(docs/tail_resolution.md: reliability at parity with the book, the entire
0.0229 log-loss gap in resolution, 0.0759 of it inside the market's 0.72+
bucket).

A graded label can only supply that if the bouts we are most timid about are
in fact the more one-sided ones. If our timidity is uncorrelated with how the
bout actually ends, the information is not in our features and no relabelling
creates it — the lab stops here.

The test, on the 180 test-split bouts where the market is >= 0.72 confident:
  under-confidence u = market_fav_prob - model_fav_prob   (market's favourite)
and then, against u, five outcome measures of one-sidedness:
  * favourite finished (ko / submission)
  * finish happened in round 1
  * among decisions, favourite swept every judged round (round_share 1.0)
  * among decisions, unanimous rather than split/majority
  * a single 0-1 `dominance-ish` blowout composite (finish OR sweep)

Reported three ways because n=180 splits into ~90 a side and a 10 pp
difference there is ~1.3 SE: a median split with a two-proportion z test, a
tertile table, and the rank correlation over all 180 (which uses the whole
spread of u instead of throwing it away at a cut point).

`--oof` enlarges the basis instead of arguing about power. The same
walk-forward harness the recalibration lab used (quarterly origins 2017-2024,
train < origin-12mo, val on the 12-month tail, score the next quarter) yields
~3.1k genuinely out-of-sample bouts strictly BEFORE the test boundary; pooled
with the 2025+ test split that is ~3× the tail rows, and a null there is a
real null rather than an underpowered one.

Usage (from scripts/simulation):
  ./venv/bin/python scripts/lab_dominance_probe.py --cache
  ./venv/bin/python scripts/lab_dominance_probe.py --cache --oof   # ~2 min
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from scipy import stats  # noqa: E402

from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402
from src.dominance import fetch_outcomes  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval_tail_buckets import averaged_probs, prepare_splits  # noqa: E402

TAIL_LO = 0.72

# Walk-forward pool — same origins/geometry as lab_oof_calibration.py, but it
# keeps bout_id and fighter_a_id so a DB outcome row can be joined back on and
# oriented. Rebuildable cache, so it lives in the gitignored data/ dir.
OOF_PATH = DATA_DIR / "lab_dominance_oof.parquet"
OOF_START = "2017-01-01"
OOF_END = "2025-01-01"
OOF_STEP_MONTHS = 3


def build_oof(use_cache: bool, rebuild: bool = False) -> pd.DataFrame:
    """Order-averaged out-of-sample probabilities, one row per scored bout."""
    if OOF_PATH.exists() and not rebuild:
        return pd.read_parquet(OOF_PATH)

    from run_rolling_backtest import VAL_MONTHS, _fit_ensemble, load_dataset

    from src.export import swap_sides
    from src.features import build_feature_matrix, feature_names

    df = load_dataset(use_cache)
    df = df[df["target_a_wins"].notna()].reset_index(drop=True)
    cols = feature_names()
    X, y, meta = build_feature_matrix(df)
    X_sw, _, _ = build_feature_matrix(swap_sides(df))
    dates = pd.to_datetime(meta["event_date"])
    debut = (
        (df["is_debut_a"].fillna(False) | df["is_debut_b"].fillna(False)).to_numpy()
        if "is_debut_a" in df.columns
        else np.zeros(len(df), dtype=bool)
    )
    exp = ~debut

    rows = []
    origin = pd.to_datetime(OOF_START)
    stop = pd.to_datetime(OOF_END)
    while origin < stop:
        nxt = origin + pd.DateOffset(months=OOF_STEP_MONTHS)
        val_start = origin - pd.DateOffset(months=VAL_MONTHS)
        tr = (dates < val_start).to_numpy() & exp
        va = ((dates >= val_start) & (dates < origin)).to_numpy() & exp
        sc = ((dates >= origin) & (dates < min(nxt, stop))).to_numpy() & exp
        if tr.sum() < 500 or va.sum() < 50 or sc.sum() == 0:
            origin = nxt
            continue
        model = _fit_ensemble(X.loc[tr, cols], y.loc[tr], X.loc[va, cols], y.loc[va], cols)
        p = model.predict_proba_a(X.loc[sc, cols].reset_index(drop=True))
        p_sw = model.predict_proba_a(X_sw.loc[sc, cols].reset_index(drop=True))
        m = meta.loc[sc].reset_index(drop=True)
        rows.append(
            pd.DataFrame(
                {
                    "bout_id": m["bout_id"].to_numpy(),
                    "fighter_a_id": m["fighter_a_id"].to_numpy(),
                    "fighter_b_id": m["fighter_b_id"].to_numpy(),
                    "model_a": 0.5 * (p + (1.0 - p_sw)),
                    "market_a": m["market_prob_a"].to_numpy(dtype=float),
                    "y_a": y.loc[sc].to_numpy().astype(int),
                }
            )
        )
        print(f"  origin {origin.date()}  train {int(tr.sum()):5d}  scored {int(sc.sum()):4d}")
        origin = nxt
    out = pd.concat(rows, ignore_index=True)
    out.to_parquet(OOF_PATH, index=False)
    return out


# ── stats helpers ──────────────────────────────────────────────────────


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval — behaves at the small n and near-0/1 rates this
    probe runs into, where the textbook normal interval does not."""
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def two_prop(k1: int, n1: int, k2: int, n2: int) -> dict[str, float]:
    """Difference in proportions with its standard error and a two-sided
    z p-value (pooled SE, as for a test of equality)."""
    if n1 == 0 or n2 == 0:
        return {"diff": float("nan"), "se": float("nan"), "p": float("nan"), "z": float("nan")}
    p1, p2 = k1 / n1, k2 / n2
    pool = (k1 + k2) / (n1 + n2)
    se = np.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2))
    z = (p1 - p2) / se if se > 0 else 0.0
    return {
        "diff": float(p1 - p2),
        "se": float(se),
        "z": float(z),
        "p": float(2 * (1 - stats.norm.cdf(abs(z)))),
    }


def logit_fit(X: np.ndarray, y: np.ndarray, names: list[str]) -> list[dict]:
    """Unpenalized logistic regression by IRLS, with Wald standard errors from
    the inverse Hessian.

    Rolled by hand rather than pulled in from statsmodels: the venv is pinned
    for reproducibility (README) and this is 20 lines. sklearn would give the
    coefficients but not the standard errors, which are the entire point here.
    An intercept column is prepended.
    """
    X = np.column_stack([np.ones(len(X)), np.asarray(X, dtype=float)])
    y = np.asarray(y, dtype=float)
    beta = np.zeros(X.shape[1])
    for _ in range(100):
        eta = np.clip(X @ beta, -30, 30)
        mu = 1 / (1 + np.exp(-eta))
        w = np.clip(mu * (1 - mu), 1e-9, None)
        H = X.T @ (X * w[:, None])
        g = X.T @ (y - mu)
        step = np.linalg.solve(H + 1e-9 * np.eye(X.shape[1]), g)
        beta = beta + step
        if np.max(np.abs(step)) < 1e-9:
            break
    eta = np.clip(X @ beta, -30, 30)
    mu = 1 / (1 + np.exp(-eta))
    w = np.clip(mu * (1 - mu), 1e-9, None)
    cov = np.linalg.inv(X.T @ (X * w[:, None]) + 1e-9 * np.eye(X.shape[1]))
    se = np.sqrt(np.diag(cov))
    out = []
    for i, nm in enumerate(["intercept", *names]):
        z = beta[i] / se[i] if se[i] > 0 else 0.0
        out.append(
            {
                "name": nm,
                "coef": float(beta[i]),
                "se": float(se[i]),
                "z": float(z),
                "p": float(2 * (1 - stats.norm.cdf(abs(z)))),
            }
        )
    return out


# ── outcome measures ───────────────────────────────────────────────────


def split_frame(prepared: dict, split: str = "test") -> pd.DataFrame:
    """Order-averaged probabilities for one static split, in the shape
    build_tail_frame consumes."""
    sp = prepared["splits"][split]
    meta = sp["meta"]
    return pd.DataFrame(
        {
            "bout_id": meta["bout_id"].to_numpy(),
            "fighter_a_id": meta["fighter_a_id"].to_numpy(),
            "fighter_b_id": meta["fighter_b_id"].to_numpy(),
            "model_a": averaged_probs(prepared["ensemble"], sp),
            "market_a": sp["market"],
            "y_a": sp["y"],
        }
    )


def build_tail_frame(
    base: pd.DataFrame, outcomes: pd.DataFrame, tail_lo: float = TAIL_LO
) -> pd.DataFrame:
    """One row per market-tail bout with u and every outcome measure, all
    expressed FROM THE MARKET FAVOURITE'S POINT OF VIEW.

    `tail_lo=0.0` keeps every bout with a line, for the whole-range control.
    """
    df = base[base["market_a"].notna()].reset_index(drop=True)
    conf = np.maximum(df["market_a"], 1 - df["market_a"])
    df = df[conf >= tail_lo].reset_index(drop=True)

    fav_is_a = df["market_a"] > 0.5
    df["fav_id"] = np.where(fav_is_a, df["fighter_a_id"], df["fighter_b_id"])
    df["market_fav"] = np.where(fav_is_a, df["market_a"], 1 - df["market_a"])
    df["model_fav"] = np.where(fav_is_a, df["model_a"], 1 - df["model_a"])
    df["u"] = df["market_fav"] - df["model_fav"]
    df["agree"] = df["model_fav"] > 0.5
    df["fav_won"] = np.where(fav_is_a, df["y_a"] == 1, df["y_a"] == 0)

    o = outcomes.set_index("bout_id")
    j = o.reindex(df["bout_id"].to_numpy())
    df["method"] = j["method"].to_numpy()
    df["round_finished"] = pd.to_numeric(j["round_finished"], errors="coerce").to_numpy()
    df["time_finished_seconds"] = pd.to_numeric(
        j["time_finished_seconds"], errors="coerce"
    ).to_numpy()
    df["card_source"] = j["card_source"].to_numpy()
    rs_a = pd.to_numeric(j["round_share_a"], errors="coerce").to_numpy()
    # round_share is stored for the RAW DB fighter_a; re-orient it onto the
    # market favourite. The symmetrized frame's fighter_a_id IS a real DB id,
    # so comparing it to the outcome row's own fighter_a_id is the honest test
    # of whether this row was flipped.
    raw_a = j["fighter_a_id"].to_numpy()
    same_side = df["fighter_a_id"].to_numpy() == raw_a
    rs_frame_a = np.where(same_side, rs_a, 1.0 - rs_a)
    df["round_share_fav"] = np.where(fav_is_a, rs_frame_a, 1.0 - rs_frame_a)

    is_finish = df["method"].isin(["ko", "tko", "submission"])
    df["fav_finish"] = (is_finish & df["fav_won"]).astype(int)
    df["fav_finish_r1"] = (df["fav_finish"].astype(bool) & (df["round_finished"] == 1)).astype(int)
    df["is_decision"] = df["method"].fillna("").str.startswith("decision")
    df["fav_unanimous"] = (
        (df["method"] == "decision_unanimous") & df["fav_won"]
    ).astype(int)
    df["fav_sweep"] = np.where(
        df["is_decision"] & pd.notna(df["round_share_fav"]),
        (df["round_share_fav"] >= 0.999).astype(float),
        np.nan,
    )
    # The composite the gate reads: one-sided by EITHER route, so it does not
    # privilege the striker's way of winning over the grappler's.
    df["blowout"] = (
        df["fav_finish"].astype(bool)
        | (df["fav_sweep"].fillna(0) > 0.5)
    ).astype(int)
    # Restricted to bouts the favourite actually won: strips out "the
    # favourite won more often" and asks only HOW they won. This is the
    # gradient a graded label adds and the binary one cannot carry.
    #
    # CAVEAT, and it is why the direction-free block below exists: `fav_won`
    # is itself downstream of u (conditional on the market price, higher u
    # goes with the favourite winning LESS — that is our model adding real
    # information about who wins). Conditioning on it is conditioning on a
    # collider, so a positive coefficient here can be induced rather than
    # causal. Reported, not leaned on.
    df["fav_wins"] = df["fav_won"].astype(bool)
    df["blowout_given_win"] = np.where(df["fav_wins"], df["blowout"], np.nan)
    df["finish_given_win"] = np.where(df["fav_wins"], df["fav_finish"], np.nan)

    # DIRECTION-FREE one-sidedness: was this bout lopsided, no matter which
    # way? This is the magnitude a graded label spreads rows along, it does
    # not condition on the winner, and it therefore has no collider in it.
    df["any_finish"] = is_finish.astype(int)
    df["any_finish_r1"] = (is_finish & (df["round_finished"] == 1)).astype(int)
    df["any_sweep"] = np.where(
        df["is_decision"] & pd.notna(df["round_share_fav"]),
        ((df["round_share_fav"] >= 0.999) | (df["round_share_fav"] <= 0.001)).astype(float),
        np.nan,
    )
    df["any_blowout"] = (
        is_finish | (df["any_sweep"].fillna(0) > 0.5)
    ).astype(int)
    return df


# ── reporting ──────────────────────────────────────────────────────────


def group_report(df: pd.DataFrame, measure: str, restrict: str | None = None) -> dict:
    """Median split on u (low = close to the market, high = timid) for one
    binary measure, plus tertiles and the rank correlation."""
    d = df if restrict is None else df[df[restrict]].reset_index(drop=True)
    d = d[pd.notna(d[measure])].reset_index(drop=True)
    n = len(d)
    if n < 8:
        return {"measure": measure, "n": n, "skipped": True}
    cut = d["u"].median()
    lo = d[d["u"] <= cut]
    hi = d[d["u"] > cut]
    k_lo, n_lo = int(lo[measure].sum()), len(lo)
    k_hi, n_hi = int(hi[measure].sum()), len(hi)
    test = two_prop(k_hi, n_hi, k_lo, n_lo)

    q = d["u"].quantile([1 / 3, 2 / 3]).to_numpy()
    tert = []
    for name, sel in (
        ("T1 closest", d["u"] <= q[0]),
        ("T2", (d["u"] > q[0]) & (d["u"] <= q[1])),
        ("T3 timid", d["u"] > q[1]),
    ):
        s = d[sel]
        k, m = int(s[measure].sum()), len(s)
        lo_ci, hi_ci = wilson(k, m)
        tert.append(
            {"band": name, "n": m, "rate": k / m if m else float("nan"),
             "ci": [lo_ci, hi_ci], "u_mean": float(s["u"].mean()) if m else float("nan")}
        )

    rho, p_rho = stats.spearmanr(d["u"], d[measure])
    return {
        "measure": measure,
        "restrict": restrict,
        "n": n,
        "cut": float(cut),
        "low": {"n": n_lo, "k": k_lo, "rate": k_lo / n_lo, "ci": list(wilson(k_lo, n_lo))},
        "high": {"n": n_hi, "k": k_hi, "rate": k_hi / n_hi, "ci": list(wilson(k_hi, n_hi))},
        "test": test,
        "tertiles": tert,
        "spearman": {"rho": float(rho), "p": float(p_rho)},
    }


def print_report(r: dict) -> None:
    if r.get("skipped"):
        print(f"  {r['measure']:<16} n={r['n']} — too few rows, skipped")
        return
    lo, hi, t = r["low"], r["high"], r["test"]
    scope = f" (among {r['restrict']})" if r["restrict"] else ""
    print(f"\n  {r['measure']}{scope}   n={r['n']}  median u={r['cut']:+.4f}")
    print(
        f"    close to market  n={lo['n']:>3}  rate {lo['rate']:.3f}  "
        f"[{lo['ci'][0]:.3f}, {lo['ci'][1]:.3f}]"
    )
    print(
        f"    most timid       n={hi['n']:>3}  rate {hi['rate']:.3f}  "
        f"[{hi['ci'][0]:.3f}, {hi['ci'][1]:.3f}]"
    )
    print(
        f"    difference  {t['diff']:+.3f}  SE {t['se']:.3f}  "
        f"({t['diff'] / t['se'] if t['se'] else float('nan'):+.2f} SE)  z={t['z']:+.2f}  p={t['p']:.3f}"
    )
    cells = "  ".join(
        f"{x['band']} n={x['n']} {x['rate']:.3f}" for x in r["tertiles"]
    )
    print(f"    tertiles: {cells}")
    print(f"    spearman rho {r['spearman']['rho']:+.4f}  p={r['spearman']['p']:.3f}")


MEASURES: tuple[tuple[str, str | None], ...] = (
    ("blowout", None),
    ("fav_finish", None),
    ("fav_finish_r1", None),
    ("fav_sweep", "is_decision"),
    ("fav_unanimous", "is_decision"),
    ("blowout_given_win", "fav_wins"),
    ("finish_given_win", "fav_wins"),
    ("any_blowout", None),
    ("any_finish", None),
    ("any_finish_r1", None),
    ("any_sweep", "is_decision"),
    ("fav_won", None),
)


def partial_report(df: pd.DataFrame, measure: str, restrict: str | None = None) -> dict:
    """Does u still predict one-sidedness once the MARKET's own confidence is
    held fixed?

    It has to be asked. u = market_fav − model_fav is mechanically larger where
    market_fav is larger (our blend is under-dispersed, so it falls further
    behind the further out the book goes), and heavier favourites finish more
    often anyway. Without market_fav in the regression, "our timidity predicts
    blowouts" and "the book's confidence predicts blowouts" are the same
    coefficient wearing different labels — and only the first one is a reason
    to relabel our training data.
    """
    d = df if restrict is None else df[df[restrict]].reset_index(drop=True)
    d = d[pd.notna(d[measure])].reset_index(drop=True)
    if len(d) < 30:
        return {"measure": measure, "n": len(d), "skipped": True}
    rows = logit_fit(
        np.column_stack([d["market_fav"].to_numpy(), d["u"].to_numpy()]),
        d[measure].to_numpy(dtype=float),
        ["market_fav", "u"],
    )
    solo = logit_fit(d[["u"]].to_numpy(), d[measure].to_numpy(dtype=float), ["u"])
    return {
        "measure": measure,
        "restrict": restrict,
        "n": len(d),
        "joint": rows,
        "u_alone": solo,
    }


def print_partial(r: dict) -> None:
    if r.get("skipped"):
        print(f"  {r['measure']:<18} n={r['n']} — too few rows, skipped")
        return
    j = {x["name"]: x for x in r["joint"]}
    s = {x["name"]: x for x in r["u_alone"]}
    print(
        f"  {r['measure']:<18} n={r['n']:>4}   "
        f"u alone {s['u']['coef']:+7.3f} ({s['u']['z']:+5.2f} z)   "
        f"| with market_fav:  u {j['u']['coef']:+7.3f} ({j['u']['z']:+5.2f} z, p={j['u']['p']:.3f})   "
        f"market_fav {j['market_fav']['coef']:+7.3f} ({j['market_fav']['z']:+5.2f} z)"
    )


def run_basis(df: pd.DataFrame, title: str) -> dict:
    print(f"\n=== STAGE 0 · {title} ===")
    print(f"  n = {len(df)}")
    print(f"  we pick the market's favourite in {df['agree'].mean():.3%} of them")
    print(f"  favourite actually wins  {df['fav_won'].mean():.3%}")
    print(
        f"  market says {df['market_fav'].mean():.3%}   we say {df['model_fav'].mean():.3%}   "
        f"mean u {df['u'].mean():+.4f} (sd {df['u'].std():.4f})"
    )
    counts = df["method"].value_counts(dropna=False)
    print("  methods: " + ", ".join(f"{k}={v}" for k, v in counts.items()))
    n_dec = int(df["is_decision"].sum())
    n_carded = int(pd.notna(df["fav_sweep"]).sum())
    print(f"  decisions {n_dec}, of which carded {n_carded}")

    print("\n--- one-sidedness vs under-confidence ---")
    reports = []
    for measure, restrict in MEASURES:
        r = group_report(df, measure, restrict)
        print_report(r)
        reports.append(r)

    # Finishing round distribution, close vs timid halves.
    cut = df["u"].median()
    print("\n--- finishing round, favourite's finishes only ---")
    fin = df[df["fav_finish"] == 1]
    for name, sel in (("close to market", fin["u"] <= cut), ("most timid", fin["u"] > cut)):
        s = fin[sel]
        dist = s["round_finished"].value_counts().sort_index()
        cells = " ".join(f"R{int(k)}={int(v)}" for k, v in dist.items())
        mean_r = s["round_finished"].mean() if len(s) else float("nan")
        print(f"  {name:<16} n={len(s):>3}  {cells or '—'}   mean round {mean_r:.2f}")

    print("\n--- same question, holding the MARKET's confidence fixed (logistic) ---")
    partials = []
    for measure, restrict in MEASURES:
        p = partial_report(df, measure, restrict)
        print_partial(p)
        partials.append(p)

    return {
        "title": title,
        "n": len(df),
        "partials": partials,
        "agree_rate": float(df["agree"].mean()),
        "fav_win_rate": float(df["fav_won"].mean()),
        "market_fav_mean": float(df["market_fav"].mean()),
        "model_fav_mean": float(df["model_fav"].mean()),
        "reports": reports,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", action="store_true", help="reuse data/dataset.parquet")
    ap.add_argument("--split", default="test", choices=("train", "val", "test"))
    ap.add_argument(
        "--oof",
        action="store_true",
        help="also run on the walk-forward 2017-2024 pool and on both pooled",
    )
    ap.add_argument("--rebuild-oof", action="store_true")
    args = ap.parse_args()

    outcomes = fetch_outcomes()
    prepared = prepare_splits(use_cache=args.cache)
    static = split_frame(prepared, split=args.split)

    bases: list[dict] = [
        run_basis(
            build_tail_frame(static, outcomes),
            f"{args.split} split, market conf >= {TAIL_LO}",
        )
    ]

    if args.oof:
        oof = build_oof(use_cache=args.cache, rebuild=args.rebuild_oof)
        bases.append(
            run_basis(
                build_tail_frame(oof, outcomes),
                f"walk-forward 2017-2024 out-of-fold, market conf >= {TAIL_LO}",
            )
        )
        pooled = pd.concat([oof, static], ignore_index=True)
        bases.append(
            run_basis(
                build_tail_frame(pooled, outcomes),
                f"POOLED out-of-sample (2017-2026), market conf >= {TAIL_LO}",
            )
        )
        bases.append(
            run_basis(
                build_tail_frame(pooled, outcomes, tail_lo=0.0),
                "POOLED out-of-sample, WHOLE range (control)",
            )
        )

    out = ARTIFACTS_DIR / "lab_dominance_probe.json"
    out.write_text(json.dumps({"bases": bases}, indent=2))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
